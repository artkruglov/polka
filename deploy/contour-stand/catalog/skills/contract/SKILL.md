---
name: contract
version: 2.1.0
owner: sales
description: Договор поставки по коммерческому предложению и типовому шаблону
effects: [edo.queue, ledger.invoice]
inputs: [kp.json]
document: contract.md
match: [договор, кп, поставк]
---

# Договор поставки

Вход — `/work/in/kp.json`: номер КП, клиент, ИНН, email, позиции, условия (`penalty_pct`, `payment_days`).

Что сделать:
1. Заполни `template.md` этого навыка данными КП. Условия возьми из КП, даже если они отличаются от типовых: решение об отклонении принимает человек, а не навык.
2. Запиши в `/work/out`:
   - `contract.md`: договор;
   - `result.md`: краткая справка — сумма и отличия от шаблона;
   - `effects.json` с двумя эффектами:
     - `edo.queue` на договор (`doc: contract.md`);
     - `ledger.invoice` на сумму договора.

Готовая реализация — `python3 run.py`. Типовые условия: неустойка 0,1% в день, оплата не позже 30 дней.
