// Direct connections (connectors/, fin.mjs sync): the bank over T-API, 1C
// over OData and the documents box over IMAP give the audit the same tails
// as the exports a bookkeeper hands over; a second run takes only what is
// new; a source that fails stops nobody else; credentials stay out of files.
// node --test deploy/finance-stand/specs/*.spec.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../company/gen.mjs";
import { realistic, writeExports } from "../company/exports.mjs";
import { companyApis } from "../systems/company-apis.mjs";
import { readExports, passportLines } from "../imports/audit.mjs";
import { readMbox, writeEml } from "../imports/mail.mjs";
import { writeInputs } from "../inputs.mjs";
import { fetchNew } from "../connectors/imap.mjs";
import { get } from "../connectors/net.mjs";
import { sync, syncLines } from "../connectors/sync.mjs";
import { imapStub } from "./imap-stub.mjs";

const SKILL = fileURLToPath(new URL("../catalog/skills/fin-match/", import.meta.url));
const key = (r) => `${r[0]}|${r[4]}|${r[5]}`;
const audit = async (dir, work, asOf) => {
  const { inputs, passport } = await readExports(dir, { asOf });
  await writeInputs(join(work, "in"), { ...inputs, passport: passportLines(passport) });
  const env = { ...process.env, WORK: work };
  execFileSync("python3", [join(SKILL, "run.py")], { env });
  assert.deepEqual(JSON.parse(execFileSync("python3", [join(SKILL, "check.py")], { env })).failed, []);
  const rows = readFileSync(join(work, "out", "tails.csv"), "utf8")
    .trim()
    .split("\n")
    .slice(1);
  return { passport, tails: rows.map((l) => key(l.split(";"))).sort() };
};
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

const SECRETS = {
  tbank: { token: "t-stand-token-1" },
  "1c": { user: "Аудит", password: "p-1c-stand-2" },
  mail: { user: "docs", password: "p-mail-stand-3" },
};

for (const seed of [41, 7]) {
  test(`seed ${seed}: the connectors give the audit the tails the exports give`, async () => {
    const work = mkdtempSync(join(tmpdir(), "fin-connect-"));
    const { firm } = realistic(generate({ seed }));
    const asOf = firm.firm.period.asOf;
    const apis = companyApis(firm, SECRETS);
    const letters = firm.mail.map((l, i) => ({ uid: 100 + i, bytes: writeEml(l, i + 1) }));
    const { server: imap, box } = imapStub({ ...SECRETS.mail, uidvalidity: 7, letters });
    try {
      // the bookkeeper's way
      await writeExports(firm, join(work, "hand"));
      const byHand = await audit(join(work, "hand"), join(work, "a"), asOf);
      assert.deepEqual(byHand.tails, firm.expected.map(key).sort());

      // the connectors' way: bank B and the EDO registry still by hand
      const [http, mail] = [await listen(apis), await listen(imap)];
      const root = join(work, "company");
      mkdirSync(join(root, "exports"), { recursive: true });
      for (const f of readdirSync(join(work, "hand")))
        if (f.includes(firm.accounts.b.account) || f.startsWith("Диадок"))
          copyFileSync(join(work, "hand", f), join(root, "exports", f));
      const config = {
        name: "stand",
        from: firm.firm.period.from,
        to: addDays(firm.firm.period.to, 1),
        sources: [
          { id: "tbank", kind: "tbank", base: `http://127.0.0.1:${http}/tbank` },
          { id: "1c", kind: "odata1c", base: `http://127.0.0.1:${http}/1c/odata/standard.odata` },
          { id: "mail", kind: "imap", url: `imap://127.0.0.1:${mail}`, name: "docs@stellazh-pro.test" },
        ],
      };
      const secret = async (id) => SECRETS[id];
      const first = await sync({ config, root, secret });
      assert.deepEqual(
        first.sources.map((s) => [s.id, s.ok, s.error]),
        [
          ["tbank", true, undefined],
          ["1c", true, undefined],
          ["mail", true, undefined],
        ],
      );
      assert.equal(first.sources[0].new, firm.bankA.length);
      assert.equal(first.sources[2].new, letters.length);
      const viaApis = await audit(join(root, "exports"), join(work, "b"), asOf);
      assert.deepEqual(viaApis.tails, byHand.tails);
      const ledger = viaApis.passport.files.find((f) => f.kind === "ledger");
      assert.ok(ledger, "1С OData.json read as the ledger");
      const odata = JSON.parse(readFileSync(join(root, "exports", "1С OData.json"), "utf8")).entities;
      assert.ok(!odata.Document_СчетНаОплатуПокупателю.some((d) => d.DeletionMark), "marked for deletion: left out");
      assert.ok(!odata.Document_ПоступлениеТоваровУслуг.some((d) => !d.Posted), "not posted: left out");
      assert.equal(viaApis.passport.mail.unread.length, 1); // the scan is still a scan

      // a second run brings nothing new and doubles nothing
      const again = await sync({ config, root, secret });
      assert.deepEqual(
        again.sources.map((s) => [s.id, s.new]),
        [
          ["tbank", 0],
          ["1c", 0],
          ["mail", 0],
        ],
      );
      assert.equal(
        readMbox(readFileSync(join(root, "exports", "Почта docs@stellazh-pro.test.mbox"))).length,
        letters.length,
      );
      assert.deepEqual((await audit(join(root, "exports"), join(work, "c"), asOf)).tails, byHand.tails);

      // a new letter comes alone; a renumbered folder is taken anew
      box.letters.push({ uid: 900, bytes: writeEml({ ...firm.mail[0], subject: "ещё одно" }, 900) });
      const third = await sync({ config, root, secret });
      assert.equal(third.sources[2].new, 1);
      box.uidvalidity = 8;
      const fourth = await sync({ config, root, secret });
      assert.equal(fourth.sources[2].new, letters.length + 1);
      assert.match(fourth.sources[2].note, /UIDVALIDITY/);
      assert.equal(
        readMbox(readFileSync(join(root, "exports", "Почта docs@stellazh-pro.test.mbox"))).length,
        letters.length + 1,
      );
      // only reading was asked of the mail server
      assert.deepEqual([...new Set(box.commands)].sort(), ["EXAMINE", "LOGIN", "LOGOUT", "UID FETCH", "UID SEARCH"]);

      // a source that fails: the others go on, its last file stays
      const wrong = async (id) => (id === "1c" ? { user: "Аудит", password: "не тот" } : SECRETS[id]);
      const failed = await sync({ config, root, secret: wrong });
      assert.deepEqual(
        failed.sources.map((s) => s.ok),
        [true, false, true],
      );
      assert.match(failed.sources[1].error, /доступ не дан \(401\)/);
      assert.match(syncLines(failed).join("\n"), /✗ 1С \(1c\): .* в аудите данные на \d{4}-\d{2}-\d{2}/);
      assert.deepEqual((await audit(join(root, "exports"), join(work, "d"), asOf)).tails.length > 0, true);

      // no credential in anything the connectors wrote
      const written = readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => readFileSync(join(e.parentPath, e.name)).toString("utf8"))
        .join("\n");
      assert.ok(written.includes("Т-Банк") || written.length > 1000);
      for (const s of [SECRETS.tbank.token, SECRETS["1c"].password, SECRETS.mail.password])
        assert.ok(!written.includes(s), "a secret in the company's folder");
    } finally {
      apis.close();
      imap.close();
      rmSync(work, { recursive: true, force: true });
    }
  });
}

test("a password goes over TLS only, except to this machine", async () => {
  await assert.rejects(
    fetchNew({ url: "imap://mail.example.ru", user: "u", password: "p" }),
    /без TLS только на этот компьютер/,
  );
  await assert.rejects(get("http://1c.example.ru/base/odata/standard.odata/Catalog_Контрагенты"), /без TLS/);
  const { server } = imapStub({ user: "u", password: "p" });
  const port = await listen(server);
  try {
    await assert.rejects(fetchNew({ url: `imap://127.0.0.1:${port}`, user: "u", password: "x" }), /LOGIN: NO/);
    await assert.rejects(
      fetchNew({ url: `imap://127.0.0.1:${port}`, user: "u", password: 'a"\r\nb' }),
      /перевод строки/,
    );
    const empty = await fetchNew({ url: `imap://127.0.0.1:${port}`, user: "u", password: "p" });
    assert.deepEqual([empty.letters.length, empty.uid], [0, 0]);
  } finally {
    server.close();
  }
});

test("what the review of M7 found: hand files beside connectors, lost files, two runs, a huge letter, a bank in clear text", async () => {
  const work = mkdtempSync(join(tmpdir(), "fin-connect-review-"));
  const { firm } = realistic(generate({ seed: 41 }));
  const asOf = firm.firm.period.asOf;
  const apis = companyApis(firm, SECRETS);
  const letters = firm.mail.map((l, i) => ({ uid: 100 + i, bytes: writeEml(l, i + 1) }));
  const { server: imap, box } = imapStub({ ...SECRETS.mail, uidvalidity: 7, letters });
  try {
    const [http, mail] = [await listen(apis), await listen(imap)];
    await writeExports(firm, join(work, "hand"));
    const byHand = await audit(join(work, "hand"), join(work, "a"), asOf);
    const root = join(work, "company");
    const exports = join(root, "exports");
    mkdirSync(exports, { recursive: true });
    // every hand-made file stays in the folder, next to what the connectors bring
    for (const f of readdirSync(join(work, "hand"))) copyFileSync(join(work, "hand", f), join(exports, f));
    const config = {
      name: "stand",
      from: firm.firm.period.from,
      to: addDays(firm.firm.period.to, 1),
      sources: [
        { id: "tbank", kind: "tbank", base: `http://127.0.0.1:${http}/tbank` },
        { id: "1c", kind: "odata1c", base: `http://127.0.0.1:${http}/1c/odata/standard.odata` },
        { id: "mail", kind: "imap", url: `imap://127.0.0.1:${mail}`, name: "docs" },
      ],
    };
    const secret = async (id) => SECRETS[id];
    // two runs at once: one of them waits for nobody and is refused
    const both = await Promise.allSettled([sync({ config, root, secret }), sync({ config, root, secret })]);
    assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.match(both.find((r) => r.status === "rejected").reason.message, /уже идёт/);

    // hand files and connector files of the same bank account and the same 1C: counted once
    const mixed = await audit(exports, join(work, "b"), asOf);
    assert.deepEqual(mixed.tails, byHand.tails);
    assert.ok(
      mixed.passport.warnings.some((w) => /есть и в Т-Банк/.test(w)),
      mixed.passport.warnings.join("\n"),
    );
    assert.ok(mixed.passport.warnings.some((w) => /списки 1С .* не взяты/.test(w)));
    // the hand mailbox export is a second copy of the same letters: one UPD counted once
    assert.equal(mixed.passport.totals.fromMail, byHand.passport.totals.fromMail);

    // a connector's file deleted: its source starts over, not from where it stopped
    rmSync(join(exports, `Т-Банк ${firm.accounts.a.account}.json`));
    rmSync(join(exports, "Почта docs.mbox"));
    const again = await sync({ config, root, secret });
    assert.equal(again.sources[0].new, firm.bankA.length);
    assert.match(again.sources[0].note, /с начала периода/);
    assert.equal(again.sources[2].new, letters.length);
    assert.match(again.sources[2].note, /файла почты нет/);

    // a letter over the limit is not downloaded, is named, and does not stop the box
    box.letters.push({ uid: 950, bytes: Buffer.concat([writeEml(firm.mail[0], 950), Buffer.alloc(300_000, 65)]) });
    box.letters.push({ uid: 951, bytes: writeEml({ ...firm.mail[1], subject: "после большого" }, 951) });
    const small = {
      ...config,
      sources: config.sources.map((x) => (x.id === "mail" ? { ...x, maxLetter: 200_000 } : x)),
    };
    const big = await sync({ config: small, root, secret });
    assert.equal(big.sources[2].new, 1);
    assert.match(big.sources[2].note, /больше 196 КБ: UID 950/);
    assert.ok(!box.fetched.includes(950));
    assert.equal((await sync({ config: small, root, secret })).sources[2].new, 0);

    // a bank address in clear text that is not this machine: refused before the token goes out
    const clear = { ...config, sources: [{ id: "tbank", kind: "tbank", base: "http://bank.example/openapi" }] };
    const refused = await sync({ config: clear, root, secret });
    assert.match(refused.sources[0].error, /без TLS только на этот компьютер/);
  } finally {
    apis.close();
    imap.close();
    rmSync(work, { recursive: true, force: true });
  }
});
