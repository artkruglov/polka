"""Draft reconciliation acts with counterparties (SKILL.md)."""
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
OUT.mkdir(parents=True, exist_ok=True)
states = json.loads((IN / "states.json").read_text(encoding="utf-8"))
firm = json.loads((IN / "firm.json").read_text(encoding="utf-8"))
money = lambda v: f"{v:,.2f}".replace(",", " ").replace(".", ",")
effects, rows = [], []
for cp in states:
    if not cp.get("edo") or not cp["obligations"]:
        continue
    # Saldo for the firm: what clients owe it minus what it owes suppliers.
    saldo = round(sum((o["amount"] - o["paid"]) * (1 if o["side"] == "ar" else -1) for o in cp["obligations"]), 2)
    lines = [f"Акт сверки взаимных расчётов за {firm['period']}", f"{firm['name']} (ИНН {firm['inn']}) — {cp['name']} (ИНН {cp['inn']})", "", "Счёт;Начислено;Оплачено"]
    lines += [f"{o['number']};{o['amount']:.2f};{o['paid']:.2f}" for o in cp["obligations"]]
    lines += ["", f"Сальдо на {firm['today']}: {saldo:.2f} {'в пользу ' + firm['name'] if saldo > 0 else 'в пользу ' + cp['name'] if saldo < 0 else '— расчёты закрыты'}"]
    effects.append({"type": "edo.draft", "inn": cp["inn"], "kind": "recon", "amount": saldo, "text": "\n".join(lines), "why": f"акт сверки с {cp['name']}"})
    rows.append(f"| {cp['name']} | {len(cp['obligations'])} | {money(saldo)} |")
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1), encoding="utf-8")
(OUT / "result.md").write_text(
    "\n".join([f"# Акты сверки за {firm['period']}", "", f"Черновиков {len(effects)}: подписывает человек.", "", "| Контрагент | Счетов | Сальдо, ₽ |", "|---|---|---|", *rows]) + "\n",
    encoding="utf-8",
)
