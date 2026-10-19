"""Checks of fin-remind (SKILL.md)."""
import json
import os
import re
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
passed, failed = [], []
check = lambda ok, name: (passed if ok else failed).append(name)
tails = {t["number"]: t for t in json.loads((IN / "tails.json").read_text(encoding="utf-8"))}
emails = {c["inn"]: c.get("email") for c in json.loads((IN / "counterparties.json").read_text(encoding="utf-8"))}
effects = json.loads((OUT / "effects.json").read_text(encoding="utf-8"))
check(all(e["type"] == "fin.mail" for e in effects), "только письма")
check(all(e.get("basis") in tails and tails[e["basis"]]["side"] == "ar" for e in effects), "каждое письмо — по долгу клиента")
check(all(e["to"] == emails.get(tails[e["basis"]]["inn"]) for e in effects if e.get("basis") in tails), "письмо тому клиенту, чей долг")
check(all(abs(float(e["amount"]) - float(tails[e["basis"]]["sum"])) < 0.01 for e in effects if e.get("basis") in tails), "сумма в письме — долг из журнала")
check(len({e["basis"] for e in effects}) == len(effects), "одно письмо на счёт")
check(not re.search(r"\b\d{20}\b", " ".join(e["body"] for e in effects)), "в письмах нет номеров счетов")
check((OUT / "result.md").exists(), "есть result.md")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
