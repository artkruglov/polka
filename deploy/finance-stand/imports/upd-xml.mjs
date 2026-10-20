// A UPD as the FNS XML file (ON_NSCHFDOPPR, formats 5.01 and 5.03): the
// same file EDO operators carry, and what a supplier outside EDO attaches to
// a letter. Read without a model: the fields are attributes. A writer for
// the specs' fixtures. No dependencies.
import { cp1251 } from "../company/gen.mjs";

const attrs = (s) => Object.fromEntries([...s.matchAll(/([\p{L}\w]+)="([^"]*)"/gu)].map((m) => [m[1], unescape(m[2])]));
const unescape = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?=[\\s/>])([^>]*?)\\/?>`, "u"));
  return m ? attrs(m[1]) : null;
};
const block = (xml, name) => xml.match(new RegExp(`<${name}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${name}>`, "u"))?.[1] ?? "";
const iso = (ru) => (ru ? ru.split(".").reverse().join("-") : "");

/** Bytes of an XML file in the declared encoding (windows-1251 as a rule). */
export function decodeXml(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const enc = head.match(/encoding="([^"]+)"/i)?.[1]?.toLowerCase() ?? "utf-8";
  return new TextDecoder(/1251/.test(enc) ? "windows-1251" : enc).decode(bytes);
}

/** A UPD from the XML, or null when the file is not one. */
export function readUpdXml(bytes) {
  const xml = decodeXml(bytes);
  const file = tag(xml, "Файл");
  const doc = tag(xml, "Документ");
  if (!file || !doc || !/ON_NSCHFDOPPR|ON_NSCHFDOPPOK|ON_SCHFDOPPR/i.test(file.ИдФайл ?? "")) return null;
  const head = tag(xml, "СвСчФакт") ?? {};
  const party = (name) => {
    const b = block(xml, name);
    const ul = tag(b, "СвЮЛУч");
    const ip = tag(b, "СвИП");
    const fio = tag(b, "ФИО");
    return ul
      ? { inn: ul.ИННЮЛ, kpp: ul.КПП ?? "", name: ul.НаимОрг }
      : ip
        ? { inn: ip.ИННФЛ, kpp: "", name: fio ? `ИП ${fio.Фамилия} ${fio.Имя ?? ""} ${fio.Отчество ?? ""}`.trim() : "" }
        : null;
  };
  const total = tag(xml, "ВсегоОпл") ?? {};
  const vatBlock = block(block(xml, "ВсегоОпл"), "СумНалВсего");
  const vat = /<БезНДС>/.test(vatBlock) ? 0 : Number(vatBlock.match(/<СумНал>([^<]+)<\/СумНал>/)?.[1] ?? NaN);
  // Основание передачи (JS \b knows no Cyrillic, hence the lookaheads): the invoice, or the contract when the supplier named that
  const basis = [...xml.matchAll(/<ОснПер(?=[\s/>])([^>]*?)\/?>/gu)]
    .map((m) => attrs(m[1]))
    .find((o) => /сч[её]т/i.test(o.НаимОсн ?? ""));
  return {
    format: file.ВерсФорм ?? "",
    func: doc.Функция ?? "",
    number: head.НомерДок ?? head.НомерСчФ ?? "",
    date: iso(head.ДатаДок ?? head.ДатаСчФ),
    seller: party("СвПрод"),
    buyer: party("СвПокуп"),
    amount: Number(total.СтТовУчНалВсего),
    vat: Number.isNaN(vat) ? null : vat,
    basis: basis?.НомОсн ?? "",
  };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const ru = (iso) => iso.split("-").reverse().join(".");
const party = (p) =>
  p.inn.length === 12
    ? `<ИдСв><СвИП ИННФЛ="${p.inn}"><ФИО Фамилия="${esc(p.name.replace(/^ИП /, "").split(" ")[0])}" Имя="${esc(p.name.replace(/^ИП /, "").split(" ").slice(1).join(" ") || "-")}"/></СвИП></ИдСв>`
    : `<ИдСв><СвЮЛУч НаимОрг="${esc(p.name)}" ИННЮЛ="${p.inn}" КПП="${p.kpp}"/></ИдСв>`;

/** The XML of a UPD, format 5.03, in windows-1251. */
export function writeUpdXml({ number, date, seller, buyer, amount, vat, basis }) {
  const net = (amount - vat).toFixed(2);
  const id = `ON_NSCHFDOPPR_${buyer.inn}_${seller.inn}_${date.replace(/-/g, "")}_${number.replace(/\W/g, "")}`;
  const xml = [
    '<?xml version="1.0" encoding="windows-1251"?>',
    `<Файл ИдФайл="${id}" ВерсФорм="5.03" ВерсПрог="stand">`,
    `<Документ КНД="1115131" Функция="СЧФДОП" ДатаИнфПр="${ru(date)}" ВремИнфПр="09.00.00" НаимЭконСубСост="${esc(seller.name)}">`,
    `<СвСчФакт НомерДок="${esc(number)}" ДатаДок="${ru(date)}">`,
    `<СвПрод>${party(seller)}</СвПрод>`,
    `<СвПокуп>${party(buyer)}</СвПокуп>`,
    '<ДенИзм КодОКВ="643" НаимОКВ="Российский рубль"/>',
    "</СвСчФакт>",
    "<ТаблСчФакт>",
    `<ВсегоОпл СтТовБезНДСВсего="${net}" СтТовУчНалВсего="${amount.toFixed(2)}"><СумНалВсего>${vat ? `<СумНал>${vat.toFixed(2)}</СумНал>` : "<БезНДС>без НДС</БезНДС>"}</СумНалВсего></ВсегоОпл>`,
    "</ТаблСчФакт>",
    `<СвПродПер><СвПер СодОпер="Товары переданы"><ОснПер НаимОсн="Счет на оплату" НомОсн="${esc(basis)}"/></СвПер></СвПродПер>`,
    "</Документ>",
    "</Файл>",
  ].join("\r\n");
  return { name: `${id}.xml`, bytes: cp1251(xml) };
}
