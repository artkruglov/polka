"""Checks of fin-inbox (SKILL.md)."""
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
passed, failed = [], []
check = lambda ok, name: (passed if ok else failed).append(name)
letters = {m["id"]: m for m in json.loads((IN / "letters.json").read_text(encoding="utf-8"))}
props = [json.loads(l) for l in (OUT / "proposals.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
effects = json.loads((OUT / "effects.json").read_text(encoding="utf-8"))
check(effects == [], "разбор ничего не отправляет")
check(all(p["type"] in ("Response", "MatchDocument") for p in props), "в журнал только ответы и вложенные УПД")
check(not any(p["type"] == "MatchPayment" for p in props), "слова письма не закрывают оплату")
docs = [p for p in props if p["type"] == "MatchDocument"]
check(all(p["docId"].startswith("mail:") and (letters.get(p["docId"][5:]) or {}).get("attachment") for p in docs), "УПД только из вложения письма")
check((OUT / "result.md").exists(), "есть result.md")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
