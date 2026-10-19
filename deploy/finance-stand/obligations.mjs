// Obligations of the finance stand (deploy/finance-stand/README.md): who owes
// whom how much and for what. Nothing writes an obligation's state: a
// command is checked against the obligation's events so far (decide), and
// what it yields is appended to the journal; every view (tails,
// counterparty cards, metrics) is a projection of that journal and can be
// rebuilt from it at any time.
//
// An obligation is closed only when both of its lines are: the money (paid
// in full, not twice) and the documents (an UPD with the right VAT). An
// open exception — changed requisites, a wrong amount, the ledger at odds
// with EDO — keeps it open until a person decides.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const VAT = 22;
export const ASK_EVERY_DAYS = 3;
const cents = (x) => Math.round(Number(x) * 100);
export const vatOf = (amount, rate = VAT) => cents((amount * rate) / (100 + rate)) / 100;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;

const empty = (id) => ({
  id,
  detected: false,
  side: null,
  inn: "",
  name: "",
  number: "",
  amount: 0,
  due: null,
  paid: 0,
  payments: [],
  docs: [],
  asks: [],
  exceptions: [],
  responses: [],
  closed: false,
});

/** An obligation after one more event. */
export function evolve(s, e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "Detected":
      return {
        ...s,
        detected: true,
        side: d.side,
        inn: d.inn,
        name: d.name,
        number: d.number,
        amount: d.amount,
        due: d.due,
        date: d.date,
      };
    case "PaymentMatched":
      return {
        ...s,
        paid: (cents(s.paid) + cents(d.amount)) / 100,
        payments: [...s.payments, { opId: d.opId, amount: d.amount, date: d.date }],
      };
    case "DocumentMatched":
      return { ...s, docs: [...s.docs, { docId: d.docId, kind: d.kind, amount: d.amount, vat: d.vat, ok: d.ok }] };
    case "DocumentRequested":
    case "ReminderSent":
      return { ...s, asks: [...s.asks, { type: e.type, at: e.at, via: d.via }] };
    case "ResponseReceived":
      return { ...s, responses: [...s.responses, { at: e.at, from: d.from, summary: d.summary }] };
    case "ExceptionRaised":
      // An exception reopens a closed obligation: a second payment or the
      // ledger at odds with EDO may come after both lines closed.
      return {
        ...s,
        closed: false,
        exceptions: [...s.exceptions, { kind: d.kind, why: d.why, amount: d.amount ?? null, open: true, at: e.at }],
      };
    case "ExceptionResolved":
      return {
        ...s,
        exceptions: s.exceptions.map((x) =>
          x.kind === d.kind && x.open ? { ...x, open: false, resolvedBy: d.why } : x,
        ),
      };
    case "HumanDecided":
      return {
        ...s,
        exceptions: s.exceptions.map((x) =>
          x.kind === d.kind && x.open ? { ...x, open: false, decision: d.decision, by: d.by } : x,
        ),
      };
    case "Closed":
      return { ...s, closed: true, closedAt: e.at };
    default:
      return s;
  }
}

export const fold = (id, events) => events.filter((e) => e.id === id).reduce(evolve, empty(id));

/** The two lines of an obligation. */
export function lines(s) {
  // Paid in parts is fine; paid beyond the amount is a second payment.
  const money =
    cents(s.paid) > cents(s.amount)
      ? "twice"
      : cents(s.paid) === cents(s.amount)
        ? "closed"
        : s.paid > 0
          ? "partial"
          : "open";
  const docs = s.docs.some((d) => d.kind === "upd" && d.ok)
    ? "closed"
    : s.docs.some((d) => d.kind === "upd")
      ? "wrong"
      : "open";
  return { money, docs };
}
const closable = (s) => {
  const l = lines(s);
  return s.detected && !s.closed && l.money === "closed" && l.docs === "closed" && !s.exceptions.some((x) => x.open);
};

// JS's \w is ASCII only: Cyrillic letters are spelled out.
const REQUISITES =
  /смен[а-яё]*\s+(банковск[а-яё]*\s+)?реквизит|нов[а-яё]*\s+(расч[её]тн[а-яё]*\s+)?сч[её]т|оплачивать на (другой|новый) сч[её]т/i;

/** Events a command yields for an obligation, or a refusal. */
export function decide(s, cmd, at) {
  const ev = (type, data = {}) => ({ type, id: s.id, at, data, by: cmd.by ?? null });
  const out = [];
  const after = (events) => {
    const next = events.reduce(evolve, s);
    return closable(next) ? [...events, ev("Closed", { why: "деньги и документы закрыты" })] : events;
  };
  switch (cmd.type) {
    case "Detect":
      if (s.detected) return { events: [] };
      return {
        events: [
          ev("Detected", {
            side: cmd.side,
            inn: cmd.inn,
            name: cmd.name,
            number: cmd.number,
            amount: cmd.amount,
            due: cmd.due,
            date: cmd.date,
          }),
        ],
      };
    case "MatchPayment": {
      if (!s.detected) return { refused: "обязательство не найдено" };
      if (s.payments.some((p) => p.opId === cmd.opId)) return { events: [] };
      out.push(ev("PaymentMatched", { opId: cmd.opId, amount: cmd.amount, date: cmd.date }));
      if (cents(s.paid) >= cents(s.amount))
        out.push(
          ev("ExceptionRaised", {
            kind: "дубль_оплаты",
            why: `второй платёж ${cmd.amount} по уже оплаченному ${s.number}`,
          }),
        );
      return { events: after(out) };
    }
    case "MatchDocument": {
      if (!s.detected) return { refused: "обязательство не найдено" };
      if (s.docs.some((d) => d.docId === cmd.docId)) return { events: [] };
      const vatOk = Math.abs(Number(cmd.vat) - vatOf(cmd.amount)) < 1;
      const amountOk = Math.abs(Number(cmd.amount) - s.amount) < 0.01;
      out.push(
        ev("DocumentMatched", {
          docId: cmd.docId,
          kind: cmd.kind,
          amount: cmd.amount,
          vat: cmd.vat,
          ok: vatOk && amountOk,
        }),
      );
      // A corrected UPD settles the wrong-VAT exception by itself: the
      // document is what the exception was about.
      if (cmd.kind === "upd" && vatOk && amountOk && s.exceptions.some((x) => x.kind === "ошибка_ндс" && x.open))
        out.push(ev("ExceptionResolved", { kind: "ошибка_ндс", why: "пришёл исправленный УПД" }));
      if (cmd.kind === "upd" && !vatOk)
        out.push(
          ev("ExceptionRaised", {
            kind: "ошибка_ндс",
            why: `НДС ${cmd.vat}, по ставке ${VAT}% должно быть ${vatOf(cmd.amount)}`,
          }),
        );
      else if (cmd.kind === "upd" && !amountOk)
        out.push(ev("ExceptionRaised", { kind: "сумма", why: `УПД на ${cmd.amount}, счёт на ${s.amount}` }));
      return { events: after(out) };
    }
    case "LedgerMismatch":
      if (s.exceptions.some((x) => x.kind === "учёт_эдо" && x.open)) return { events: [] };
      return { events: [ev("ExceptionRaised", { kind: "учёт_эдо", why: cmd.why, amount: cmd.diff ?? null })] };
    case "RequestDocument":
    case "Remind": {
      if (s.closed) return { refused: "обязательство уже закрыто" };
      const last = s.asks.at(-1);
      if (last && days(last.at, at) < ASK_EVERY_DAYS)
        return { refused: `уже писали ${last.at.slice(0, 10)}: не чаще раза в ${ASK_EVERY_DAYS} дня` };
      if (s.exceptions.some((x) => x.kind === "реквизиты" && x.open))
        return { refused: "контрагент сменил реквизиты: ждём решения человека" };
      return { events: [ev(cmd.type === "Remind" ? "ReminderSent" : "DocumentRequested", { via: cmd.via })] };
    }
    case "Response": {
      out.push(ev("ResponseReceived", { from: cmd.from, summary: String(cmd.text ?? "").slice(0, 200) }));
      // Changed requisites are never taken from a letter: a person checks them by phone.
      if (REQUISITES.test(cmd.text ?? ""))
        out.push(
          ev("ExceptionRaised", {
            kind: "реквизиты",
            why: "контрагент пишет о новых реквизитах: проверить по телефону из договора",
          }),
        );
      return { events: out };
    }
    case "Decide":
      if (!s.exceptions.some((x) => x.kind === cmd.kind && x.open)) return { refused: "нет открытого исключения" };
      if (!cmd.by) return { refused: "решает человек" };
      return { events: after([ev("HumanDecided", { kind: cmd.kind, decision: cmd.decision, by: cmd.by })]) };
    default:
      return { refused: `нет команды ${cmd.type}` };
  }
}

// ---- projections
export function states(events) {
  const ids = [...new Set(events.map((e) => e.id))];
  return ids.map((id) => fold(id, events)).filter((s) => s.detected);
}

/** One row per obligation that is not closed: what is missing and how much. */
export function tails(events, asOf) {
  const rows = [];
  for (const s of states(events)) {
    if (s.closed) continue;
    const l = lines(s);
    const open = s.exceptions.filter((x) => x.open).map((x) => x.kind);
    let kind = null;
    let sum = s.amount;
    if (open.includes("учёт_эдо"))
      [kind, sum] = ["учёт_эдо", s.exceptions.find((x) => x.kind === "учёт_эдо" && x.open).amount];
    else if (l.money === "twice") [kind, sum] = ["дубль_оплаты", s.amount];
    else if (open.includes("ошибка_ндс") || l.docs === "wrong") {
      const doc = s.docs.find((d) => d.kind === "upd" && !d.ok);
      [kind, sum] = ["ошибка_ндс", doc ? Math.abs(cents(vatOf(doc.amount)) - cents(doc.vat)) / 100 : null];
    } else if (l.money === "partial") [kind, sum] = ["частичная", (cents(s.amount) - cents(s.paid)) / 100];
    else if (l.money === "open" && s.due && s.due < asOf)
      kind = s.side === "ar" ? "просрочка" : l.docs === "closed" ? "нет_оплаты" : null;
    else if (l.money === "closed" && l.docs === "open" && s.side === "ap") kind = "нет_упд";
    if (!kind && !open.length) continue;
    rows.push({
      id: s.id,
      number: s.number,
      side: s.side,
      name: s.name,
      inn: s.inn,
      kind: kind ?? open[0],
      sum,
      money: l.money,
      docs: l.docs,
      open,
      asks: s.asks.length,
      last: s.asks.at(-1)?.at ?? null,
    });
  }
  return rows.sort((a, b) => a.number.localeCompare(b.number));
}

export function metrics(events, asOf) {
  const all = states(events);
  const t = tails(events, asOf);
  const byKind = t.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});
  return {
    obligations: all.length,
    closed: all.filter((s) => s.closed).length,
    tails: t.length,
    byKind,
    exceptionsOpen: all.reduce((n, s) => n + s.exceptions.filter((x) => x.open).length, 0),
    asks: events.filter((e) => e.type === "DocumentRequested" || e.type === "ReminderSent").length,
    responses: events.filter((e) => e.type === "ResponseReceived").length,
    decisions: events.filter((e) => e.type === "HumanDecided").length,
  };
}

// ---- the journal: one file, appended, the source of every projection
export const JOURNAL = process.env.FIN_JOURNAL ?? "/var/lib/finance/events.jsonl";

export async function journal(file = JOURNAL) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Apply commands in order; the refusals come back, the events are appended. */
export async function apply(commands, { at, file = JOURNAL, publish } = {}) {
  const events = await journal(file);
  const appended = [];
  const refused = [];
  for (const cmd of commands) {
    const s = fold(cmd.id, [...events, ...appended]);
    const r = decide(s, cmd, cmd.at ?? at);
    if (r.refused) refused.push({ cmd, why: r.refused });
    else appended.push(...r.events);
  }
  if (appended.length) {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, appended.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const e of appended) await publish?.(e);
  }
  return { appended, refused };
}
