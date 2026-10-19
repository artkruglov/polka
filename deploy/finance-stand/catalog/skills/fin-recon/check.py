"""Checks of fin-recon (SKILL.md)."""
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
passed, failed = [], []
check = lambda ok, name: (passed if ok else failed).append(name)
states = {s["inn"]: s for s in json.loads((IN / "states.json").read_text(encoding="utf-8"))}
effects = json.loads((OUT / "effects.json").read_text(encoding="utf-8"))
check(all(e["type"] == "edo.draft" and e.get("kind") == "recon" for e in effects), "только черновики актов сверки")
check(all(states.get(e["inn"], {}).get("edo") for e in effects), "только контрагентам в ЭДО")
check(len({e["inn"] for e in effects}) == len(effects), "один акт на контрагента")
ok = True
for e in effects:
    s = states[e["inn"]]
    want = round(sum((o["amount"] - o["paid"]) * (1 if o["side"] == "ar" else -1) for o in s["obligations"]), 2)
    ok = ok and abs(want - e["amount"]) < 0.01
check(ok, "сальдо сходится с журналом")
check((OUT / "result.md").exists(), "есть result.md")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
