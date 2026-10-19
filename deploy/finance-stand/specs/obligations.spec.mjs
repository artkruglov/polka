// The rules of an obligation as given / when / then (obligations.mjs):
// given the events so far, when a command comes, then these events or a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, fold, vatOf } from "../obligations.mjs";

const ID = "ob-П-0101";
const at = (day) => `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`;
const detected = {
  type: "Detected",
  id: ID,
  at: at(1),
  data: { side: "ap", inn: "1", name: "ООО «Поставщик»", number: "П-0101", amount: 122000, due: "2026-09-20" },
};
const paid = { type: "PaymentMatched", id: ID, at: at(1), data: { opId: "op-1", amount: 122000, date: "2026-09-10" } };
const upd = {
  type: "DocumentMatched",
  id: ID,
  at: at(2),
  data: { docId: "edo-1", kind: "upd", amount: 122000, vat: vatOf(122000), ok: true },
};

function spec(name, { given, when, at: time = at(5), then, refused }) {
  test(name, () => {
    const r = decide(fold(ID, given), { id: ID, ...when }, time);
    if (refused) assert.match(r.refused ?? "", refused);
    else
      assert.deepEqual(
        r.events.map((e) => [e.type, e.data.kind ?? null]),
        then,
      );
  });
}

spec("closed only when both lines are: money first, then the UPD", {
  given: [detected, paid],
  when: { type: "MatchDocument", docId: "edo-1", kind: "upd", amount: 122000, vat: vatOf(122000) },
  then: [
    ["DocumentMatched", "upd"],
    ["Closed", null],
  ],
});
spec("an UPD with last year's VAT closes nothing and raises an exception", {
  given: [detected, paid],
  when: { type: "MatchDocument", docId: "edo-1", kind: "upd", amount: 122000, vat: vatOf(122000, 20) },
  then: [
    ["DocumentMatched", "upd"],
    ["ExceptionRaised", "ошибка_ндс"],
  ],
});
spec("a second payment of a paid obligation is an exception, and reopens it", {
  given: [detected, paid, upd, { type: "Closed", id: ID, at: at(2), data: {} }],
  when: { type: "MatchPayment", opId: "op-2", amount: 122000, date: "2026-09-12" },
  then: [
    ["PaymentMatched", null],
    ["ExceptionRaised", "дубль_оплаты"],
  ],
});
spec("the same payment twice is one payment", {
  given: [detected, paid],
  when: { type: "MatchPayment", opId: "op-1", amount: 122000, date: "2026-09-10" },
  then: [],
});
spec("one letter to a counterparty in three days, not more", {
  given: [detected, paid, { type: "DocumentRequested", id: ID, at: at(3), data: { via: "edo" } }],
  when: { type: "RequestDocument", via: "mail" },
  at: at(4),
  refused: /не чаще раза в 3 дня/,
});
spec("after three days the next request goes", {
  given: [detected, paid, { type: "DocumentRequested", id: ID, at: at(3), data: { via: "edo" } }],
  when: { type: "RequestDocument", via: "edo" },
  at: at(6),
  then: [["DocumentRequested", null]],
});
spec("new requisites in a letter are an exception for a person, never an update", {
  given: [detected, paid],
  when: {
    type: "Response",
    from: "buh@x.test",
    text: "У нас сменились банковские реквизиты, оплачивайте на новый счёт",
  },
  then: [
    ["ResponseReceived", null],
    ["ExceptionRaised", "реквизиты"],
  ],
});
spec("while requisites are in doubt, the agent does not write again", {
  given: [detected, paid, { type: "ExceptionRaised", id: ID, at: at(2), data: { kind: "реквизиты" } }],
  when: { type: "RequestDocument", via: "edo" },
  refused: /сменил реквизиты/,
});
spec("an exception is closed by a person only", {
  given: [detected, paid, { type: "ExceptionRaised", id: ID, at: at(2), data: { kind: "реквизиты" } }],
  when: { type: "Decide", kind: "реквизиты", decision: "реквизиты прежние, письмо — мошенничество" },
  refused: /решает человек/,
});
spec("a person's decision closes the exception, and the obligation if its lines are closed", {
  given: [detected, paid, upd, { type: "ExceptionRaised", id: ID, at: at(2), data: { kind: "реквизиты" } }],
  when: { type: "Decide", kind: "реквизиты", decision: "реквизиты прежние", by: "petrova" },
  then: [
    ["HumanDecided", "реквизиты"],
    ["Closed", null],
  ],
});
spec("a closed obligation gets no reminders", {
  given: [detected, paid, upd, { type: "Closed", id: ID, at: at(2), data: {} }],
  when: { type: "Remind", via: "mail" },
  refused: /уже закрыто/,
});
spec("a corrected UPD settles the wrong-VAT exception and closes the obligation", {
  given: [
    detected,
    paid,
    {
      type: "DocumentMatched",
      id: ID,
      at: at(2),
      data: { docId: "edo-1", kind: "upd", amount: 122000, vat: vatOf(122000, 20), ok: false },
    },
    { type: "ExceptionRaised", id: ID, at: at(2), data: { kind: "ошибка_ндс" } },
  ],
  when: { type: "MatchDocument", docId: "edo-2", kind: "upd", amount: 122000, vat: vatOf(122000) },
  then: [
    ["DocumentMatched", "upd"],
    ["ExceptionResolved", "ошибка_ндс"],
    ["Closed", null],
  ],
});
spec("paid in two parts is paid, not twice", {
  given: [
    detected,
    upd,
    { type: "PaymentMatched", id: ID, at: at(1), data: { opId: "op-1", amount: 50000, date: "2026-09-10" } },
  ],
  when: { type: "MatchPayment", opId: "op-2", amount: 72000, date: "2026-10-09" },
  then: [
    ["PaymentMatched", null],
    ["Closed", null],
  ],
});
