"""Remind clients of overdue and partly paid invoices (SKILL.md)."""
import json
import os
from datetime import date
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
OUT.mkdir(parents=True, exist_ok=True)
load = lambda n: json.loads((IN / n).read_text(encoding="utf-8"))
tails, firm = load("tails.json"), load("firm.json")
cps = {c["inn"]: c for c in load("counterparties.json")}
today = date.fromisoformat(firm["today"])
money = lambda v: f"{v:,.2f}".replace(",", " ").replace(".", ",")
effects, skipped = [], []
for t in tails:
    if t["side"] != "ar" or t["kind"] not in ("просрочка", "частичная"):
        continue
    if t.get("open"):
        skipped.append((t, f"открыто исключение: {', '.join(t['open'])}"))
        continue
    if t.get("last") and (today - date.fromisoformat(t["last"][:10])).days < 3:
        skipped.append((t, f"писали {t['last'][:10]}"))
        continue
    cp = cps.get(t["inn"])
    if not cp or not cp.get("email"):
        skipped.append((t, "нет почты в справочнике"))
        continue
    rest = "остаток по счёту" if t["kind"] == "частичная" else "сумма по счёту"
    body = (
        f"Добрый день! Напоминаем об оплате счёта № {t['number']}: {rest} {money(t['sum'])} ₽, срок оплаты прошёл. "
        f"Если оплата уже ушла, пришлите, пожалуйста, номер и дату платёжного поручения. {firm['name']}, бухгалтерия."
    )
    effects.append({"type": "fin.mail", "to": cp["email"], "subject": f"Оплата счёта {t['number']}", "body": body, "basis": t["number"], "amount": t["sum"], "why": f"{t['kind']}: {t['number']}"})
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1), encoding="utf-8")
lines = [f"# Напоминания на {firm['today']}", "", f"Писем {len(effects)}, отложено {len(skipped)}.", "", "| Счёт | Клиент | Долг, ₽ |", "|---|---|---|"]
lines += [f"| {e['basis']} | {next(c['name'] for c in cps.values() if c['email'] == e['to'])} | {money(e['amount'])} |" for e in effects]
if skipped:
    lines += ["", "Не пишем:", *[f"- {t['number']} {t['name']}: {why}" for t, why in skipped]]
(OUT / "result.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
