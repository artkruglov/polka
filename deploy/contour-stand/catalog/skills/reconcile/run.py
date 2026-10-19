"""Reconcile a bank statement with invoices; propose reminders (SKILL.md)."""
import csv
import json
import os
import re
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
OUT.mkdir(parents=True, exist_ok=True)
params = json.loads((IN / "params.json").read_text()) if (IN / "params.json").exists() else {}
partial = params.get("partial", "paid")
as_of = params.get("as_of", "9999-12-31")


def rows(name):
    with open(IN / name, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter=";"))


def money(v):
    return f"{v:,.0f}".replace(",", " ")


invoices = rows("invoices.csv")
payments = rows("statement.csv")
paid = {i["счёт"]: 0.0 for i in invoices}
unmatched = []
for p in payments:
    amount = float(p["сумма"])
    number = re.search(r"\b(СЧ-\d+)\b", p["назначение"])
    target = number.group(1) if number and number.group(1) in paid else None
    if not target:
        same_inn = [i["счёт"] for i in invoices if i["инн"] == p["инн"]]
        target = same_inn[0] if len(same_inn) == 1 else None
    if target:
        paid[target] += amount
    else:
        unmatched.append(p)

lines = ["| Счёт | Контрагент | Сумма | Оплачено | Статус |", "|---|---|---|---|---|"]
debtors, effects = [], []
for i in invoices:
    total, got = float(i["сумма"]), paid[i["счёт"]]
    if got >= total:
        status = "оплачен"
    elif got > 0 and partial == "paid":
        status = "оплачен частично, считается оплаченным"
    elif i["срок"] >= as_of:
        status = "срок не наступил"
    else:
        status = "долг"
        debt = round(total - got, 2)
        debtors.append({**i, "долг": debt})
        effects.append({
            "type": "mail.send",
            "to": i["email"],
            "amount": debt,
            "subject": f"Напоминание об оплате счёта {i['счёт']}",
            "body": f"Здравствуйте! По счёту {i['счёт']} остаток к оплате {money(debt)} ₽, срок был {i['срок']}. "
            "Если оплата уже ушла, пришлите, пожалуйста, платёжное поручение.",
        })
    lines.append(f"| {i['счёт']} | {i['контрагент']} | {money(total)} | {money(got)} | {status} |")

report = [f"# Сверка оплат на {as_of}", "", f"Частичная оплата: {'считается оплаченной' if partial == 'paid' else 'остаток — долг'}.", ""]
report += lines + ["", f"Должников: {len(debtors)}. Платежей без счёта: {len(unmatched)}."]
for p in unmatched:
    report.append(f"- {p['дата']} {p['плательщик']} {p['сумма']} ₽: «{p['назначение']}»")
(OUT / "result.md").write_text("\n".join(report) + "\n", encoding="utf-8")
with open(OUT / "debtors.csv", "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["счёт", "контрагент", "email", "долг"])
    for d in debtors:
        w.writerow([d["счёт"], d["контрагент"], d["email"], d["долг"]])
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"debtors={len(debtors)} unmatched={len(unmatched)}")
