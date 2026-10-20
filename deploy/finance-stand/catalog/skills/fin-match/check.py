"""Checks of fin-match's result (SKILL.md); prints {"passed": [...], "failed": [...]}."""
import csv
import json
import os
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
passed, failed = [], []


def check(ok, name):
    (passed if ok else failed).append(name)


KINDS = {"нет_упд", "просрочка", "нет_оплаты", "частичная", "ошибка_ндс", "дубль_оплаты", "учёт_эдо"}
ledger = json.loads((IN / "ledger.json").read_text(encoding="utf-8"))
numbers = {
    d.get("НомерВходящегоДокумента") or d["Number"]
    for e in ("Document_СчетНаОплатуПоставщика", "Document_СчетНаОплатуПокупателю")
    for d in ledger[e]
}
try:
    with open(OUT / "tails.csv", encoding="utf-8") as f:
        tails = list(csv.DictReader(f, delimiter=";"))
    check(True, "tails.csv читается")
except Exception:
    tails = []
    check(False, "tails.csv читается")
check(all(t["обязательство"] in numbers for t in tails), "каждый хвост — счёт из учёта")
check(all(t["хвост"] in KINDS for t in tails), "виды хвостов из списка")
check(all(float(t["сумма"]) > 0 for t in tails), "суммы хвостов положительные")
check(len({(t["обязательство"], t["инн"]) for t in tails}) == len(tails), "один хвост на счёт")
effects = json.loads((OUT / "effects.json").read_text()) if (OUT / "effects.json").exists() else None
check(effects == [], "сверка ничего не отправляет")
props = [json.loads(l) for l in (OUT / "proposals.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
allowed = {"Detect", "MatchPayment", "MatchDocument", "LedgerMismatch"}
check(all(p["type"] in allowed for p in props), "в журнал только сверочные команды")
check(all(p["id"].removeprefix("ob-").split("@")[0] in numbers for p in props), "команды только о счетах из учёта")
check((OUT / "result.md").exists(), "есть result.md")
print(json.dumps({"passed": passed, "failed": failed}, ensure_ascii=False))
