"""Match money and primary documents; list the tails (SKILL.md)."""
import json
import os
import re
from pathlib import Path

W = Path(os.environ.get("WORK", "/work"))
IN, OUT = W / "in", W / "out"
OUT.mkdir(parents=True, exist_ok=True)
VAT = 22
RATES = (22, 10, 7, 5, 0)  # 2026: the general rate, the reduced one, VAT on the simplified system, none
load = lambda name: json.loads((IN / name).read_text(encoding="utf-8"))
ops = load("operations.json")
edo = load("edo.json")
ledger = load("ledger.json")
firm = load("firm.json")
params = json.loads((IN / "params.json").read_text()) if (IN / "params.json").exists() else {}
as_of = params.get("as_of") or firm["asOf"]


def cents(x):
    return round(float(x) * 100)


def vat_of(amount, rate=VAT):
    return round(amount * rate / (100 + rate), 2)


def vat_ok(d):
    return d.get("vat") is None or any(abs(d["vat"] - vat_of(d["amount"], r)) < 1 for r in RATES)


def money(v):
    return f"{v:,.2f}".replace(",", " ").replace(".", ",")


# Obligations: one per invoice. A supplier's invoice goes by the supplier's own
# number (the one in our payment's purpose); numbers repeat across suppliers,
# so an invoice is its side, its counterparty and its number.
cps = {c["Ref_Key"]: c for c in ledger["Catalog_Контрагенты"]}
invoices = {}
for side, entity in (("ap", "Document_СчетНаОплатуПоставщика"), ("ar", "Document_СчетНаОплатуПокупателю")):
    for d in ledger[entity]:
        cp = cps.get(d.get("Контрагент_Key"))
        if not cp:
            continue
        number = d.get("НомерВходящегоДокумента") or d["Number"]
        invoices[(side, cp["ИНН"], number)] = {
            "side": side,
            "number": number,
            "inn": cp["ИНН"],
            "name": cp["Description"],
            "amount": float(d["СуммаДокумента"]),
            "date": d["Date"][:10],
            "due": d["СрокОплаты"][:10],
            "payments": [],
            "upd": [],
            "ledger": None,
        }
count = {}
for inv in invoices.values():
    count[inv["number"]] = count.get(inv["number"], 0) + 1
for inv in invoices.values():
    inv["id"] = f"ob-{inv['number']}" if count[inv["number"]] == 1 else f"ob-{inv['number']}@{inv['inn']}"
by_inn = {}
for inv in invoices.values():
    by_inn.setdefault(inv["inn"], []).append(inv)
digits = lambda number: int(re.sub(r"\D", "", number) or -1)
remaining = lambda i: cents(i["amount"]) - sum(cents(p["amount"]) for p in i["payments"])

# 1. Money: number in the purpose, then the amount, then the only open invoice.
NUM = re.compile(r"(?:№|сч(?:ёт|ет)?\.?|счету|счёту)\s*(?:[А-ЯA-Z]+-)?0*(\d+)", re.I)
# «по счетам № ИСХ-0514, ИСХ-0520 и 531»: every number of the list
LIST = re.compile(r"сч(?:ё|е)там\s*(?:№\s*)?((?:[А-ЯA-Z]+-)?\d+(?:\s*(?:,|;|и)\s*(?:№\s*)?(?:[А-ЯA-Z]+-)?\d+)+)", re.I)
unmatched = []
for op in sorted(ops, key=lambda o: (o["date"], o["opId"])):
    side = "ap" if op["direction"] == "out" else "ar"
    pool = [i for i in by_inn.get(op["inn"], []) if i["side"] == side] if op["inn"] and op["inn"] != firm["inn"] else []
    if not pool:
        continue  # fees, taxes, salary, own transfers, cards: no obligation behind them
    listed = [int(n) for m in LIST.finditer(op["purpose"]) for n in re.findall(r"\d+", m.group(1))]
    several = [i for i in pool if digits(i["number"]) in listed]
    if len(several) > 1 and sum(max(remaining(i), 0) for i in several) == cents(op["amount"]):
        for i in several:  # one order, several invoices: each gets its remainder
            i["payments"].append({**op, "opId": f"{op['opId']}/{i['number']}", "amount": remaining(i) / 100})
        continue
    target = None
    for m in NUM.finditer(op["purpose"]):
        hit = [i for i in pool if digits(i["number"]) == int(m.group(1))]
        if len(hit) == 1:
            target = hit[0]
            break
    if not target:
        # No number: the open invoice with exactly this remainder, else the
        # oldest open one (FIFO, as 1C allocates a payment by contract), else
        # an invoice already paid with exactly this amount — a second payment.
        open_ = sorted((i for i in pool if remaining(i) > 0 and i["date"] <= op["date"]), key=lambda i: (i["date"], i["number"]))
        exact = [i for i in open_ if remaining(i) == cents(op["amount"])]
        fits = [i for i in open_ if remaining(i) >= cents(op["amount"])]
        again = [i for i in pool if cents(i["amount"]) == cents(op["amount"]) and remaining(i) <= 0]
        target = exact[0] if exact else fits[0] if fits else again[0] if len(again) == 1 else None
    if target:
        target["payments"].append(op)
    else:
        unmatched.append(op)

# 2. Documents. A UPD names its invoice when the stand's EDO carries a basis;
# a registry of an EDO operator does not, so then: the same counterparty and
# amount, the latest invoice before the document.
by_number = {}
for inv in invoices.values():
    by_number.setdefault(inv["number"], []).append(inv)
loose = []
for d in sorted(edo, key=lambda d: (d["date"], d["id"])):
    if d["kind"] != "upd" or d.get("status") == "rejected":
        continue
    side = "ap" if d["dir"] == "in" else "ar"
    named = [i for i in by_number.get(d.get("basis") or "", []) if i["side"] == side and i["inn"] in (d["inn"], "")]
    if len(named) == 1:
        named[0]["upd"].append(d)
        continue
    same = [i for i in by_inn.get(d["inn"], []) if i["side"] == side and cents(i["amount"]) == cents(d["amount"])]
    free = sorted((i for i in same if i["date"] <= d["date"] and not i["upd"]), key=lambda i: i["date"])
    target = free[-1] if free else None
    if target:
        target["upd"].append(d)
    else:
        loose.append(d)
# The ledger's receipt or sale: by its basis, else by the UPD's number.
upd_of = {(d["inn"], d["number"]): i for i in invoices.values() for d in i["upd"]}
for d in ledger.get("Document_ПоступлениеТоваровУслуг", []) + ledger.get("Document_РеализацияТоваровУслуг", []):
    if not d.get("Posted"):
        continue
    inn = cps.get(d.get("Контрагент_Key"), {}).get("ИНН", "")
    named = [i for i in by_number.get(d.get("ДокументОснование") or "", []) if inn in (i["inn"], "")]
    inv = named[0] if len(named) == 1 else upd_of.get((inn, d.get("НомерВходящегоДокумента") or d.get("Number")))
    if inv:
        inv["ledger"] = float(d["СуммаДокумента"])

# 3. Tails, and the commands for the journal.
proposals, tails = [], []
for inv in sorted(invoices.values(), key=lambda i: (i["number"], i["inn"])):
    proposals.append({"type": "Detect", **{k: inv[k] for k in ("id", "side", "inn", "name", "number", "amount", "due", "date")}})
    for d in inv["upd"]:
        proposals.append({"type": "MatchDocument", "id": inv["id"], "docId": d["id"], "kind": "upd", "amount": d["amount"], "vat": d["vat"]})
    for p in inv["payments"]:
        proposals.append({"type": "MatchPayment", "id": inv["id"], "opId": p["opId"], "amount": p["amount"], "date": p["date"]})
    upd_ok = [d for d in inv["upd"] if vat_ok(d) and abs(d["amount"] - inv["amount"]) < 0.01]
    upd_bad = [d for d in inv["upd"] if d not in upd_ok]
    paid = sum(cents(p["amount"]) for p in inv["payments"])
    total = cents(inv["amount"])
    diff = None
    if inv["upd"] and inv["ledger"] is not None and abs(inv["ledger"] - inv["upd"][0]["amount"]) >= 0.01:
        diff = round(inv["ledger"] - inv["upd"][0]["amount"], 2)
        proposals.append({"type": "LedgerMismatch", "id": inv["id"], "why": f"в учёте {inv['ledger']:.2f}, в УПД {inv['upd'][0]['amount']:.2f}", "diff": abs(diff)})
    kind, sum_ = None, inv["amount"]
    if diff is not None:
        kind, sum_ = "учёт_эдо", abs(diff)
    elif paid > total:
        kind = "дубль_оплаты"
    elif upd_bad and not upd_ok:
        kind, sum_ = "ошибка_ндс", abs(vat_of(upd_bad[0]["amount"]) - (upd_bad[0]["vat"] or 0))
    elif 0 < paid < total:
        kind, sum_ = "частичная", (total - paid) / 100
    elif paid == 0 and inv["due"] < as_of:
        kind = "просрочка" if inv["side"] == "ar" else ("нет_оплаты" if upd_ok else None)
    elif paid >= total and not inv["upd"] and inv["side"] == "ap":
        kind = "нет_упд"
    if kind:
        tails.append([inv["number"], inv["side"], inv["name"], inv["inn"], kind, f"{sum_:.2f}"])

(OUT / "tails.csv").write_text(
    "обязательство;сторона;контрагент;инн;хвост;сумма\n" + "".join(";".join(t) + "\n" for t in tails), encoding="utf-8"
)
(OUT / "proposals.jsonl").write_text("".join(json.dumps(p, ensure_ascii=False) + "\n" for p in proposals), encoding="utf-8")
(OUT / "effects.json").write_text("[]\n")

KIND = {
    "нет_упд": "оплачено, нет УПД",
    "просрочка": "клиент просрочил оплату",
    "нет_оплаты": "УПД есть, оплаты нет",
    "частичная": "частичная оплата",
    "ошибка_ндс": "ошибка НДС в УПД",
    "дубль_оплаты": "оплачено дважды",
    "учёт_эдо": "учёт не совпадает с ЭДО",
}
counts = {}
for t in tails:
    counts[t[4]] = counts.get(t[4], 0) + 1
lines = [
    f"# Хвосты на {as_of}",
    "",
    f"Обязательств {len(invoices)}, закрыто по обеим линиям {len(invoices) - len(tails)}, хвостов **{len(tails)}**.",
    "",
    "| Хвост | Сколько |",
    "|---|---|",
    *[f"| {KIND[k]} | {v} |" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])],
    "",
    "| Счёт | Контрагент | Хвост | Сумма, ₽ |",
    "|---|---|---|---|",
    *[f"| {t[0]} | {t[2]} | {KIND[t[4]]} | {money(float(t[5]))} |" for t in tails],
    "",
    f"Платежей без счёта у контрагентов из учёта: {len(unmatched)}. Первичных документов без счёта: {len(loose)}.",
]
# An audit of a company's exports: what the reconciliation was built from.
if (IN / "passport.json").exists():
    lines += ["", "## Из чего собрано", "", "```", *load("passport.json"), "```"]
(OUT / "result.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
