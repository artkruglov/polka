"""Fill the supply contract template from a commercial offer (SKILL.md)."""
import datetime
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT, SKILL = W / "in", W / "out", Path(__file__).parent
OUT.mkdir(parents=True, exist_ok=True)
kp = json.loads((IN / "kp.json").read_text())
STANDARD = {"penalty_pct": 0.1, "payment_days": 30}


def money(v):
    return f"{v:,.0f}".replace(",", " ")


total = sum(i["qty"] * i["price"] for i in kp["items"])
items = "\n".join(f"- {i['name']}: {i['qty']} × {money(i['price'])} ₽" for i in kp["items"])
terms = kp["terms"]
contract = (SKILL / "template.md").read_text().format(
    number=kp["number"].replace("КП", "Д"),
    date=datetime.date.today().strftime("%d.%m.%Y"),
    client=kp["client"],
    inn=kp["inn"],
    items=items,
    total=money(total),
    payment_days=terms["payment_days"],
    penalty_pct=str(terms["penalty_pct"]).replace(".", ","),
)
(OUT / "contract.md").write_text(contract, encoding="utf-8")
diffs = [f"- {k}: {terms[k]} вместо типовых {v}" for k, v in STANDARD.items() if terms[k] != v]
(OUT / "result.md").write_text(
    f"# Договор по {kp['number']}\n\nКлиент: {kp['client']}. Сумма: {money(total)} ₽.\n\n"
    + ("Отличия от шаблона:\n" + "\n".join(diffs) if diffs else "Условия типовые.")
    + "\n",
    encoding="utf-8",
)
effects = [
    {"type": "edo.queue", "doc": "contract.md", "counterparty": kp["client"], "title": f"Договор по {kp['number']}"},
    {"type": "ledger.invoice", "counterparty": kp["client"], "inn": kp["inn"], "amount": total, "basis": kp["number"]},
]
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"total={total} diffs={len(diffs)}")
