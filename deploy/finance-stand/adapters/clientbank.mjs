// The «Клиент-банк → 1С» exchange file (1CClientBankExchange, format 1.03),
// the export almost every Russian bank gives: windows-1251 (or DOS) text,
// «Key=Value» lines, one section per payment order. Turned into the stand's
// operation shape (adapters/tbank.mjs, normalize). No dependencies.

/** Bytes of an export as text: «Кодировка=Windows» or «DOS» in the header. */
export function decode(bytes) {
  return new TextDecoder(encodingOf(bytes)).decode(bytes);
}
// «Кодировка» is itself written in the file's encoding.
const encodingOf = (bytes) =>
  /Кодировка=DOS/.test(new TextDecoder("ibm866").decode(bytes.subarray(0, 400))) ? "ibm866" : "windows-1251";

export function parse(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "1CClientBankExchange") throw new Error("не файл 1CClientBankExchange");
  const header = {};
  const accounts = new Set();
  const sections = [];
  const docs = [];
  let doc = null,
    section = null;
  for (const line of lines.slice(1)) {
    const eq = line.indexOf("=");
    const key = eq < 0 ? line.trim() : line.slice(0, eq);
    const value = eq < 0 ? "" : line.slice(eq + 1).trim();
    if (key === "СекцияДокумент") doc = { Вид: value };
    else if (key === "КонецДокумента") {
      if (doc) docs.push(doc);
      doc = null;
    } else if (key === "СекцияРасчСчет") section = {};
    else if (key === "КонецРасчСчет") {
      if (section) sections.push(section);
      section = null;
    } else if (doc) doc[key] = value;
    else if (section) section[key] = value;
    else if (eq > 0) header[key] ??= value;
    if (key === "РасчСчет" && value && !doc) accounts.add(value);
  }
  return { header, accounts, sections, docs };
}

const isoDate = (ru) => {
  const [d, m, y] = ru.split(".");
  return `${y}-${m}-${d}`;
};
const sum = (s) => (s === undefined || s === "" ? null : Number(String(s).replace(",", ".")));

/** The file whole: operations, the firm's accounts and what the bank says it sent. */
export function statementOf(bytes, bank = "b") {
  const { header, accounts, sections, docs } = parse(decode(bytes));
  // An order between two accounts of the firm is ours on both sides.
  const ours = (acc) => accounts.has(acc);
  const operations = docs.map((d) => {
    const incoming = ours(d.ПолучательСчет) && !(ours(d.ПлательщикСчет) && d.ДатаСписано && !d.ДатаПоступило);
    const side = incoming ? "Плательщик" : "Получатель";
    return {
      bank,
      // an order's number is the payer's: two clients may send «№ 15» the same day
      opId: `${bank}:${d.Номер}:${d.Дата}:${d[`${side}ИНН`] ?? ""}:${d.Сумма}`,
      date: isoDate(d.ДатаПоступило || d.ДатаСписано || d.Дата),
      amount: Number(d.Сумма),
      direction: incoming ? "in" : "out",
      inn: d[`${side}ИНН`] ?? "",
      name: d[`${side}1`] || (d[side] ?? "").replace(/^ИНН \d+\s*/, ""),
      account: d[`${side}Счет`] ?? "",
      purpose: d.НазначениеПлатежа ?? "",
      docNo: d.Номер ?? "",
      ourAccount: incoming ? d.ПолучательСчет : d.ПлательщикСчет,
    };
  });
  const firmDoc = docs.find((d) => ours(d.ПлательщикСчет)) ?? docs.find((d) => ours(d.ПолучательСчет));
  const firmSide = firmDoc && ours(firmDoc.ПлательщикСчет) ? "Плательщик" : "Получатель";
  return {
    encoding: encodingOf(bytes),
    from: header.ДатаНачала ? isoDate(header.ДатаНачала) : null,
    to: header.ДатаКонца ? isoDate(header.ДатаКонца) : null,
    accounts: [...accounts],
    firm: firmDoc
      ? {
          inn: firmDoc[`${firmSide}ИНН`],
          name: firmDoc[`${firmSide}1`] || (firmDoc[firmSide] ?? "").replace(/^ИНН \d+\s*/, ""),
        }
      : null,
    // СекцияРасчСчет: the bank's own totals, to see that nothing was cut off
    balances: sections.map((s) => ({
      account: s.РасчСчет,
      from: s.ДатаНачала ? isoDate(s.ДатаНачала) : null,
      to: s.ДатаКонца ? isoDate(s.ДатаКонца) : null,
      opening: sum(s.НачальныйОстаток),
      income: sum(s.ВсегоПоступило),
      outcome: sum(s.ВсегоСписано),
      closing: sum(s.КонечныйОстаток),
    })),
    operations,
  };
}

/** Payment orders of the file as operations of the account it was exported for. */
export function operations(bytes, bank = "b") {
  return statementOf(bytes, bank).operations.map(({ ourAccount, ...op }) => op);
}
