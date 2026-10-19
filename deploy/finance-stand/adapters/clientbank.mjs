// The «Клиент-банк → 1С» exchange file (1CClientBankExchange, format 1.03),
// the export almost every Russian bank gives: windows-1251 (or DOS) text,
// «Key=Value» lines, one section per payment order. Turned into the stand's
// operation shape (adapters/tbank.mjs, normalize). No dependencies.

/** Bytes of an export as text: «Кодировка=Windows» or «DOS» in the header. */
export function decode(bytes) {
  const head = new TextDecoder("windows-1251").decode(bytes.subarray(0, 400));
  return new TextDecoder(/Кодировка=DOS/.test(head) ? "ibm866" : "windows-1251").decode(bytes);
}

export function parse(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "1CClientBankExchange") throw new Error("не файл 1CClientBankExchange");
  const header = {};
  const docs = [];
  let doc = null;
  for (const line of lines.slice(1)) {
    const eq = line.indexOf("=");
    const key = eq < 0 ? line.trim() : line.slice(0, eq);
    const value = eq < 0 ? "" : line.slice(eq + 1).trim();
    if (key === "СекцияДокумент") doc = { Вид: value };
    else if (key === "КонецДокумента") {
      if (doc) docs.push(doc);
      doc = null;
    } else if (doc) doc[key] = value;
    else if (eq > 0) header[key] ??= value;
  }
  return { header, docs };
}

const isoDate = (ru) => {
  const [d, m, y] = ru.split(".");
  return `${y}-${m}-${d}`;
};

/** Payment orders of the file as operations of the account it was exported for. */
export function operations(bytes, bank = "b") {
  const { header, docs } = parse(decode(bytes));
  const ours = header.РасчСчет;
  return docs.map((d) => {
    const incoming = d.ПолучательСчет === ours;
    const side = incoming ? "Плательщик" : "Получатель";
    return {
      bank,
      opId: `${bank}:${d.Номер}:${d.Дата}`,
      date: isoDate(d.ДатаПоступило || d.ДатаСписано || d.Дата),
      amount: Number(d.Сумма),
      direction: incoming ? "in" : "out",
      inn: d[`${side}ИНН`] ?? "",
      name: d[`${side}1`] || (d[side] ?? "").replace(/^ИНН \d+\s*/, ""),
      account: d[`${side}Счет`] ?? "",
      purpose: d.НазначениеПлатежа ?? "",
      docNo: d.Номер ?? "",
    };
  });
}
