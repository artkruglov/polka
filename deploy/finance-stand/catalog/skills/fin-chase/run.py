"""Ask suppliers for missing or corrected UPDs (SKILL.md)."""
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
effects, skipped = [], []
for t in tails:
    if t["side"] != "ap" or t["kind"] not in ("нет_упд", "ошибка_ндс"):
        continue
    cp = cps.get(t["inn"])
    if "реквизиты" in t.get("open", []):
        skipped.append((t, "ждёт решения человека о реквизитах"))
        continue
    if t.get("last") and (today - date.fromisoformat(t["last"][:10])).days < 3:
        skipped.append((t, f"писали {t['last'][:10]}"))
        continue
    if t["kind"] == "ошибка_ндс":
        ask = f"в УПД по счёту № {t['number']} НДС посчитан не по ставке 22%. Просим прислать исправленный УПД."
    else:
        ask = f"оплата по счёту № {t['number']} прошла, а УПД к нам не поступал. Просим направить УПД."
    text = f"Добрый день! {ask} {firm['name']}, бухгалтерия."
    why = f"{t['kind']}: {t['number']}"
    if cp and cp.get("edo"):
        effects.append({"type": "edo.request", "inn": t["inn"], "basis": t["number"], "text": text, "why": why})
    elif cp and cp.get("email"):
        effects.append({"type": "fin.mail", "to": cp["email"], "subject": f"УПД по счёту {t['number']}", "body": text, "basis": t["number"], "why": why})
    else:
        skipped.append((t, "нет ни ЭДО, ни почты в справочнике"))
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1), encoding="utf-8")
rows = [f"| {e['basis']} | {cps[e.get('inn') or next(c['inn'] for c in cps.values() if c['email'] == e['to'])]['name']} | {'ЭДО' if e['type'] == 'edo.request' else 'письмо'} |" for e in effects]
lines = [f"# Запросы первички на {firm['today']}", "", f"Запросов {len(effects)}, отложено {len(skipped)}.", "", "| Счёт | Поставщик | Канал |", "|---|---|---|", *rows]
if skipped:
    lines += ["", "Не пишем:", *[f"- {t['number']} {t['name']}: {why}" for t, why in skipped]]
(OUT / "result.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
