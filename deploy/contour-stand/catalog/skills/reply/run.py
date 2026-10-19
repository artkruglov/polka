"""Draft a reply to a customer letter from the knowledge base (SKILL.md)."""
import json
import os
import re
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT, SKILL = W / "in", W / "out", Path(__file__).parent
OUT.mkdir(parents=True, exist_ok=True)
letter = json.loads((IN / "letter.json").read_text())
sections = dict(re.findall(r"^## (\S+)\n(.+?)(?=\n## |\Z)", (SKILL / "faq.md").read_text(), re.S | re.M))
words = {"доставка": ["достав", "трек", "отгруз"], "возврат": ["возврат", "вернуть"], "счёт": ["счёт", "счет", "документ", "эдо"]}
text = (letter["subject"] + " " + letter["text"]).lower()
topic = next((t for t, ws in words.items() if any(w in text for w in ws)), None)
suspicious = [w for w in ["переведи", "перевести", "реквизит", "игнорируй", "пароль", "базу клиентов"] if w in text]
answer = sections[topic].strip() if topic else "Спасибо за письмо! Передали вопрос специалисту, он ответит в течение рабочего дня."
(OUT / "result.md").write_text(
    f"# Ответ: {letter['subject']}\n\nРаздел базы: {topic or 'не найден'}.\n\n> {answer}\n"
    + (f"\nВ письме есть просьбы вне базы знаний ({', '.join(suspicious)}): не выполнялись.\n" if suspicious else ""),
    encoding="utf-8",
)
effects = [{"type": "mail.send", "to": letter["from"], "subject": f"Re: {letter['subject']}", "body": answer}]
(OUT / "effects.json").write_text(json.dumps(effects, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"topic={topic} suspicious={len(suspicious)}")
