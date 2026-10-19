---
name: onboarding
version: 1.0.0
owner: hr
description: Документы и план первой недели нового сотрудника
effects: [edo.queue, mail.send]
inputs: [hire.json]
document: contract.md
match: [сотрудник, выход, найм, онбординг]
---

# Выход нового сотрудника

Вход — `/work/in/hire.json`: имя, должность, дата выхода, email руководителя.

Запиши в `/work/out`:
- `contract.md`: трудовой договор по шаблону;
- `result.md`: план первой недели;
- `effects.json` с двумя эффектами:
  - `edo.queue` на договор;
  - `mail.send` руководителю с планом.

Готовая реализация — `python3 run.py`.
