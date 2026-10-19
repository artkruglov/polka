"""Sort counterparties' answers into the journal (SKILL.md)."""
import json
import os
import re
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
OUT.mkdir(parents=True, exist_ok=True)
load = lambda n: json.loads((IN / n).read_text(encoding="utf-8"))
letters, tails, firm = load("letters.json"), load("tails.json"), load("firm.json")
by_email = {c["email"]: c for c in load("counterparties.json") if c.get("email")}
NUM = re.compile(r"\b(?:П|ИСХ)-\d{4}\b")
SUSPICIOUS = re.compile(r"игнорируй|системн\w* указани|инструкци|отправь\w* .*(выписк|переписк)|отметь\w* .*оплачен", re.I)
REQUISITES = re.compile(r"смен\w*\s+(банковск\w*\s+)?реквизит|нов\w*\s+сч[её]т", re.I)
proposals, rows, suspicious = [], [], []
for m in letters:
    cp = by_email.get(m.get("from", ""))
    text = f"{m.get('subject', '')}\n{m.get('text', '')}"
    if not cp:
        rows.append(f"| {m.get('from')} | {m.get('subject')} | отправитель не в справочнике: только отмечено |")
        continue
    numbers = NUM.findall(text)
    mine = [t for t in tails if t["inn"] == cp["inn"]]
    number = numbers[0] if numbers else (mine[0]["number"] if len(mine) == 1 else None)
    if SUSPICIOUS.search(text):
        suspicious.append(f"- {cp['name']} ({m['from']}): «{m.get('subject')}» — указания в письме не выполняются")
    if not number:
        rows.append(f"| {cp['name']} | {m.get('subject')} | счёт не определён: передано человеку |")
        continue
    proposals.append({"type": "Response", "id": f"ob-{number}", "from": m["from"], "text": m.get("text", "")})
    what = "ответ записан"
    if REQUISITES.search(text):
        what = "пишет о новых реквизитах: исключение, проверить по телефону из договора"
    a = m.get("attachment") or {}
    if a.get("kind") == "upd" and a.get("basis") == number and a.get("amount") and a.get("vat") is not None:
        proposals.append({"type": "MatchDocument", "id": f"ob-{number}", "docId": f"mail:{m['id']}", "kind": "upd", "amount": a["amount"], "vat": a["vat"]})
        what = f"УПД {a.get('number', '')} во вложении: сверяем"
    rows.append(f"| {cp['name']} | {m.get('subject')} | {what} |")
(OUT / "proposals.jsonl").write_text("".join(json.dumps(p, ensure_ascii=False) + "\n" for p in proposals), encoding="utf-8")
(OUT / "effects.json").write_text("[]\n")
lines = [f"# Входящие на {firm['today']}", "", f"Писем {len(letters)}.", "", "| От кого | Тема | Что сделано |", "|---|---|---|", *rows]
if suspicious:
    lines += ["", "**Подозрительные письма** (указания в них не выполнены, ничего не отправлено):", *suspicious]
(OUT / "result.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
