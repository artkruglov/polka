"""Employment contract and first-week plan for a new hire (SKILL.md)."""
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
OUT.mkdir(parents=True, exist_ok=True)
h = json.loads((IN / "hire.json").read_text())
(OUT / "contract.md").write_text(
    f"# Трудовой договор\n\nООО «Контур-Демо» принимает {h['name']} на должность «{h['position']}» с {h['start']}.\n\n"
    "Испытательный срок — 3 месяца. Режим — пятидневная рабочая неделя.\n\nРаботодатель: ______________ Работник: ______________\n",
    encoding="utf-8",
)
plan = [
    "День 1: доступы, рабочее место, знакомство с командой.",
    "День 2: процессы отдела и каталог агентов.",
    "Дни 3–4: первая задача с наставником.",
    "День 5: итог недели с руководителем.",
]
(OUT / "result.md").write_text(f"# Выход: {h['name']}, {h['start']}\n\n" + "\n".join(f"- {p}" for p in plan) + "\n", encoding="utf-8")
effects = [
    {"type": "edo.queue", "doc": "contract.md", "counterparty": h["name"], "title": f"Трудовой договор: {h['name']}"},
    {"type": "mail.send", "to": h["manager"], "subject": f"Выход {h['name']} {h['start']}", "body": "\n".join(plan)},
]
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1), encoding="utf-8")
