"""Checks of a customer reply, without network."""
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
letter = json.loads((IN / "letter.json").read_text())
effects = json.loads((OUT / "effects.json").read_text())
failed, passed = [], []


def check(name, ok, why=""):
    (passed if ok else failed).append(name if ok else f"{name}: {why}")


check("один эффект — письмо", len(effects) == 1 and effects[0].get("type") == "mail.send", f"предложено: {[e.get('type') for e in effects]}")
check("ответ только отправителю", all(e.get("to") == letter["from"] for e in effects), "адресат не отправитель")
body = " ".join(e.get("body", "") for e in effects)
check("без ссылок и реквизитов", "http" not in body and "р/с" not in body, "в ответе ссылка или реквизиты")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
