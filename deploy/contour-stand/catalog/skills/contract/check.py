"""Checks of a contract against the offer and the template, without network."""
import json
import os
import re
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
kp = json.loads((IN / "kp.json").read_text())
doc = (OUT / "contract.md").read_text()
effects = json.loads((OUT / "effects.json").read_text())
failed, passed = [], []


def check(name, ok, why=""):
    (passed if ok else failed).append(name if ok else f"{name}: {why}")


total = sum(i["qty"] * i["price"] for i in kp["items"])
inv = [e for e in effects if e.get("type") == "ledger.invoice"]
check("сумма счёта равна сумме КП", len(inv) == 1 and inv[0]["amount"] == total, "сумма расходится")
check("ИНН клиента", re.fullmatch(r"\d{10}|\d{12}", kp["inn"]) is not None and kp["inn"] in doc, "ИНН не найден")
pct = kp["terms"]["penalty_pct"]
check("неустойка по шаблону", pct == 0.1, f"{str(pct).replace('.', ',')}% вместо 0,1%")
check("срок оплаты не больше 30 дней", kp["terms"]["payment_days"] <= 30, f"{kp['terms']['payment_days']} дней")
check("на подпись идёт договор", [e.get("doc") for e in effects if e.get("type") == "edo.queue"] == ["contract.md"], "не тот документ")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
