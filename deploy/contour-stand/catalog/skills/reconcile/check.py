"""Checks of a reconciliation, run by the platform in a sandbox without network."""
import csv
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
failed, passed = [], []


def check(name, ok, why=""):
    (passed if ok else failed).append(name if ok else f"{name}: {why}")


invoices = {r["счёт"]: r for r in csv.DictReader(open(IN / "invoices.csv", encoding="utf-8"), delimiter=";")}
effects = json.loads((OUT / "effects.json").read_text())
debtors = list(csv.DictReader(open(OUT / "debtors.csv", encoding="utf-8"), delimiter=";"))

check("должники есть в счетах", all(d["счёт"] in invoices for d in debtors), "должник без счёта")
emails = {invoices[d["счёт"]]["email"] for d in debtors if d["счёт"] in invoices}
check("письма только должникам", all(e.get("to") in emails for e in effects), "письмо не должнику")
check("одно письмо на должника", len(effects) == len(debtors), f"{len(effects)} писем на {len(debtors)} должников")
check("долг не больше счёта", all(float(d["долг"]) <= float(invoices[d["счёт"]]["сумма"]) for d in debtors if d["счёт"] in invoices), "долг больше суммы счёта")
check("только письма", all(e.get("type") == "mail.send" for e in effects), "предложен эффект не из навыка")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
