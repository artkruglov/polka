"""A person's decision on one exception, laid out for Полка (SKILL.md)."""
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
OUT.mkdir(parents=True, exist_ok=True)
load = lambda n: json.loads((IN / n).read_text(encoding="utf-8"))
x, firm = load("exception.json"), load("firm.json")
money = lambda v: f"{v:,.2f}".replace(",", " ").replace(".", ",") + " ₽" if isinstance(v, (int, float)) else "—"

# What the rule says, and the decision that is safe whatever the truth is.
CASES = {
    "реквизиты": (
        "Контрагент пишет о новых реквизитах. Реквизиты из письма не меняются никогда: это обычная схема мошенничества.",
        "Реквизиты не меняем: оплата только на счёт из договора. Если смена настоящая, её подтверждают звонком по телефону из договора и вносят в 1С вручную.",
    ),
    "дубль_оплаты": (
        "По счёту прошёл второй платёж. Агент не возвращает и не зачитывает деньги.",
        "Второй платёж — переплата поставщику: в акте сверки она идёт долгом поставщика, возврат или зачёт бухгалтер согласует с ним сам.",
    ),
    "учёт_эдо": (
        "Документ в учёте расходится с документом в ЭДО. Проводить документы 1С агент не может.",
        "Верным считаем документ ЭДО: бухгалтер исправляет документ в 1С.",
    ),
    "ошибка_ндс": (
        "НДС в УПД не по законной ставке. Такой УПД не даёт вычета.",
        "УПД к вычету не принимаем: ждём исправленный УПД от поставщика.",
    ),
    "сумма": (
        "Сумма УПД не совпадает со счётом.",
        "УПД на другую сумму не принимаем: просим исправленный или корректировочный УПД.",
    ),
}
LABELS = {
    "реквизиты": "смена реквизитов",
    "дубль_оплаты": "оплачено дважды",
    "учёт_эдо": "учёт ≠ ЭДО",
    "ошибка_ндс": "ошибка НДС в УПД",
    "сумма": "сумма УПД ≠ счёт",
}
DOCS = {"upd": "УПД", "act": "акт", "invoice": "счёт"}
rule, decision = CASES.get(x["kind"], ("Исключение, которое решает человек.", "Оставить как есть до разбора бухгалтером."))
side = "поставщик" if x.get("side") == "ap" else "клиент"
lines = [
    f"# Исключение по счёту {x['number']}: {LABELS.get(x['kind'], x['kind'])}",
    "",
    f"{x.get('name', '')} ({side}, ИНН {x.get('inn', '')}) · счёт на {money(x.get('amount'))}, оплачено {money(x.get('paid'))} · {firm['name']}, {firm['today']}",
    "",
    "## Что случилось",
    "",
    f"{x.get('why', '')} ({str(x.get('at', ''))[:10]})",
    "",
    rule,
    "",
    "## Основание",
    "",
]
for p in x.get("payments", []):
    lines.append(f"- платёж {money(p.get('amount'))} от {p.get('date', '')} (операция {p.get('opId', '')})")
for d in x.get("docs", []):
    lines.append(f"- {DOCS.get(d.get('kind'), d.get('kind', ''))} на {money(d.get('amount'))}, НДС {money(d.get('vat'))}{'' if d.get('ok') else ' — не принят'}")
for r in x.get("responses", [])[-2:]:
    lines.append(f"- письмо {str(r.get('at', ''))[:10]} от {r.get('from', '')}: «{r.get('summary', '')}» — слова письма ничего не закрывают")
if lines[-1] == "":
    lines.append("- в журнале нет платежей, документов и писем по счёту")
lines += [
    "",
    "## Предлагаемое решение",
    "",
    decision,
    "",
    "Примите эту версию на Полке — решение запишется в журнал обязательств как решение человека, со ссылкой на эту работу. Не согласны — не принимайте и запишите своё: `fin decide " + x["number"] + " " + x["kind"] + ' "<решение>"`.',
]
(OUT / "result.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
effects = [{"type": "fin.decision", "basis": x["number"], "kind": x["kind"], "decision": decision}]
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
