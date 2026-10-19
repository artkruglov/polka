---
name: fin-recon
version: 1.0.0
owner: finance
description: Черновики актов сверки с контрагентами к концу квартала
effects: [edo.draft]
inputs: [states.json, firm.json]
match: [акт сверки, сверка взаиморасч, конец квартал]
---

# Акты сверки

Вход в `/work/in`:
- `states.json` — обязательства по контрагентам из журнала: `inn, name, edo, obligations: [number, side, amount, paid]`;
- `firm.json` — `name, inn, today, period`.

По каждому контрагенту в ЭДО, с которым были обороты за период, предложи черновик акта сверки `edo.draft`:
- `inn`, `kind: "recon"`;
- `amount` — сальдо в пользу фирмы (плюс) или контрагента (минус);
- `text` — таблица оборотов: счёт, начислено, оплачено.

Черновик подписывает человек: действие решает человек, не политика.

Готовая реализация — `python3 run.py`.
