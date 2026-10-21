// The finance packs' hook (work.hook in processes/*.yaml): the swarm calls
// it with each result and each effect, and it keeps the journal of
// obligations (obligations.mjs). A reconciliation's proposals become events;
// an effect that would break an obligation's rule — a second letter within
// three days, a letter while requisites are in doubt — is refused before the
// gateway; an effect that went out is recorded.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JOURNAL, apply, decide, fold, journal, metrics, tails } from "./obligations.mjs";

const DATA = process.env.FIN_DATA ?? "/var/lib/finance";
const FIN = "http://127.0.0.1:7071";

/** A goal's journal: the firm's, or an audit's own (params.journal). */
export const journalOf = (params = {}) =>
  params.journal ? join(DATA, "journals", `${String(params.journal).replace(/[^\w.-]/g, "_")}.jsonl`) : JOURNAL;
export const projectionOf = (file) => file.replace(/\.jsonl$/, ".projection.json");

/** The firm's day: the simulator's clock, so letters and answers line up. */
async function today() {
  const r = await fetch(`${FIN}/sim/clock`).catch(() => null);
  return (r?.ok && (await r.json()).date) || new Date().toISOString().slice(0, 10);
}
async function asOfOf(params) {
  if (params?.as_of) return params.as_of;
  const company = JSON.parse(await readFile(join(DATA, "company", "company.json"), "utf8").catch(() => "{}"));
  return company.firm?.period?.asOf ?? (await today());
}

/** The live projection, written next to the journal after every change. */
export async function project(file, asOf) {
  const events = await journal(file);
  const view = { asOf, events: events.length, tails: tails(events, asOf), metrics: metrics(events, asOf) };
  await writeFile(`${projectionOf(file)}.tmp`, JSON.stringify(view, null, 1));
  await rename(`${projectionOf(file)}.tmp`, projectionOf(file));
  return view;
}

async function record(g, commands, ctx) {
  const file = journalOf(g.params);
  const at = `${await today()}T09:00:00Z`;
  const r = await apply(
    commands.map((c) => ({ ...c, by: c.by ?? g.id })),
    { at, file, publish: (e) => ctx?.publish?.("fin.events", e) },
  );
  const view = await project(file, await asOfOf(g.params));
  await ctx?.note?.(
    "journal",
    `журнал обязательств: +${r.appended.length} событий${r.refused.length ? `, отказов ${r.refused.length}` : ""}; хвостов ${view.tails.length}`,
  );
  return r;
}

export async function afterReview(g, results, ctx) {
  const text = await readFile(join(results, "proposals.jsonl"), "utf8").catch(() => "");
  const commands = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  if (commands.length) await record(g, commands, ctx);
}

// An effect as a command of the obligation it is about.
async function commandOf(g, e) {
  if (!e.basis) return null;
  const id = `ob-${e.basis}`;
  if (e.type === "edo.request") return { type: "RequestDocument", id, via: "edo" };
  if (e.type === "fin.mail") {
    const s = fold(id, await journal(journalOf(g.params)));
    return { type: s.side === "ar" ? "Remind" : "RequestDocument", id, via: "mail" };
  }
  return null;
}

export async function beforeEffect(g, e) {
  // A decision about an exception that is gone (a corrected УПД came, or
  // someone decided by command) has nothing left to decide.
  if (e.type === "fin.decision") {
    const s = fold(`ob-${e.basis}`, await journal(journalOf(g.params)));
    const x = s.exceptions.findLast((y) => y.kind === e.kind);
    return x && !x.open ? `исключение уже закрыто: ${x.decision ?? x.resolvedBy}` : null;
  }
  const cmd = await commandOf(g, e);
  if (!cmd) return null;
  const r = decide(fold(cmd.id, await journal(journalOf(g.params))), cmd, `${await today()}T09:00:00Z`);
  return r.refused ?? null;
}

export async function afterEffect(g, e, _response, ctx) {
  const cmd = await commandOf(g, e);
  if (cmd) await record(g, [cmd], ctx);
}

// fin.decision is the stand's own record (effects/finance.json, «hook»): the
// decision a person accepted on Полка becomes HumanDecided in the journal.
// Полка says a person accepted, not which one: the work names the decision.
export async function effect(g, e, _key, ctx) {
  const by = `человек на Полке, работа ${g.polka?.artifactId ?? "?"}`;
  const file = journalOf(g.params);
  const r = await record(g, [{ type: "Decide", id: `ob-${e.basis}`, kind: e.kind, decision: e.decision, by }], ctx);
  if (!r.refused.length) return { status: 200, json: { id: `${e.basis}:${e.kind}` } };
  // The same decision recorded before: a repeat of the gateway's call.
  const done = fold(`ob-${e.basis}`, await journal(file)).exceptions.some((x) => x.kind === e.kind && x.by === by);
  return done
    ? { status: 200, json: { id: `${e.basis}:${e.kind}`, repeated: true } }
    : { status: 409, json: { error: r.refused[0].why } };
}
