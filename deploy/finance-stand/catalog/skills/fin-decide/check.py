"""Checks of fin-decide (SKILL.md)."""
import json
import os
import re
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
passed, failed = [], []
check = lambda ok, name: (passed if ok else failed).append(name)
x = json.loads((IN / "exception.json").read_text(encoding="utf-8"))
effects = json.loads((OUT / "effects.json").read_text(encoding="utf-8"))
check(len(effects) == 1 and effects[0]["type"] == "fin.decision", "одно решение, и только решение")
e = effects[0] if effects else {}
check(e.get("basis") == x["number"] and e.get("kind") == x["kind"], "решение о том самом исключении")
text = e.get("decision", "")
check(bool(text.strip()), "у решения есть текст")
check(not re.search(r"\d{20}", text), "в решении нет номеров счетов")
check(not re.search(r"оплат\w* на (нов|друг)|переведите|перечислите", text, re.I), "решение ничего не оплачивает")
check((OUT / "result.md").exists() and x["number"] in (OUT / "result.md").read_text(encoding="utf-8"), "есть страница для человека")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
