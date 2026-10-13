// `ops doctor` (scripts/doctor.ts): the verdicts of scripts/doctor-lib.ts.
// The I/O half runs against the live services; here every answer it can
// get maps to the right mark, the exit status and no secret in the output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { getDomain } from "tldts";
import {
  backupCheck,
  certificateCheck,
  exitCode,
  oidcCheck,
  render,
  schemaCheck,
  scrub,
  signInChecks,
  siteCheck,
  storageChecks,
  type Check,
} from "../scripts/doctor-lib.ts";

const domain = (host: string) => getDomain(host, { allowPrivateDomains: true });
const now = new Date("2026-10-13T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

test("the viewer must be on another registrable domain", () => {
  assert.equal(siteCheck("polka.company.ru", "polka-view.company.net", domain).mark, "ok");
  assert.equal(siteCheck("polka.company.ru", "view.company.ru", domain).mark, "fail");
  assert.equal(siteCheck("polka.company.co.uk", "view.company.co.uk", domain).mark, "fail");
  assert.equal(siteCheck("polka.company.ru", "polka.company.ru", domain).mark, "fail");
  // Distinct sites under a public multi-part suffix.
  assert.equal(siteCheck("a.company.co.uk", "b.other.co.uk", domain).mark, "ok");
});

test("schema: current passes, behind or ahead fails, unreachable explains", () => {
  assert.equal(schemaCheck(73, 73).mark, "ok");
  assert.equal(schemaCheck(72, 73).mark, "fail");
  assert.equal(schemaCheck(74, 73).mark, "fail");
  assert.equal(schemaCheck(null, 73).mark, "fail");
  const down = schemaCheck(new Error("connect ECONNREFUSED"), 73);
  assert.equal(down.mark, "fail");
  assert.match(down.hint!, /postgres/);
});

test("storage: versioning, the readiness object and conditional writes", () => {
  const good = storageChecks("b", { versioning: "Enabled", canary: "present", conditional: "enforced" });
  assert.deepEqual(
    good.map((check) => check.mark),
    ["ok", "ok", "ok"],
  );
  const marks = (probe: Parameters<typeof storageChecks>[1]) => storageChecks("b", probe).map((check) => check.mark);
  assert.deepEqual(marks({ versioning: "Suspended", canary: "present", conditional: "enforced" }), [
    "fail",
    "ok",
    "ok",
  ]);
  assert.deepEqual(marks({ versioning: undefined, canary: "missing", conditional: "skipped" }), ["fail", "fail"]);
  assert.deepEqual(marks({ versioning: "Enabled", canary: "present", conditional: "not-enforced" }), [
    "ok",
    "ok",
    "fail",
  ]);
  assert.deepEqual(marks({ versioning: new Error("AccessDenied"), canary: "missing", conditional: "skipped" }), [
    "fail",
  ]);
});

test("backups: fresh within the interval plus two hours", () => {
  assert.equal(backupCheck("bk", hoursAgo(3), 86_400, now).mark, "ok");
  assert.equal(backupCheck("bk", hoursAgo(25.9), 86_400, now).mark, "ok");
  assert.equal(backupCheck("bk", hoursAgo(26), 86_400, now).mark, "fail");
  assert.equal(backupCheck("bk", hoursAgo(3.5), 3600, now).mark, "fail");
  assert.equal(backupCheck("bk", null, 86_400, now).mark, "fail");
  assert.equal(backupCheck(undefined, null, 86_400, now).mark, "fail");
  assert.equal(backupCheck("bk", new Error("AccessDenied"), 86_400, now).mark, "fail");
});

test("certificates: trusted and not about to expire", () => {
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
  assert.equal(certificateCheck("x", "h", { validTo: days(60), authorized: true }, now).mark, "ok");
  assert.equal(certificateCheck("x", "h", { validTo: days(5), authorized: true }, now).mark, "warn");
  assert.equal(certificateCheck("x", "h", { validTo: days(-1), authorized: true }, now).mark, "fail");
  assert.equal(certificateCheck("x", "h", { validTo: days(60), authorized: false }, now).mark, "fail");
  assert.equal(certificateCheck("x", "h", new Error("ECONNREFUSED"), now).mark, "fail");
});

test("OIDC discovery: the four fields and the issuer at the same address", () => {
  const url = "https://id.company.ru/realms/main/.well-known/openid-configuration";
  const doc = {
    issuer: "https://id.company.ru/realms/main",
    authorization_endpoint: "https://id.company.ru/a",
    token_endpoint: "https://id.company.ru/t",
    jwks_uri: "https://id.company.ru/j",
  };
  assert.equal(oidcCheck(undefined, undefined, "r").mark, "info");
  assert.equal(oidcCheck(url, doc, "r").mark, "ok");
  assert.equal(oidcCheck(url, { ...doc, jwks_uri: undefined }, "r").mark, "fail");
  assert.equal(oidcCheck(url, { ...doc, issuer: "https://other" }, "r").mark, "fail");
  assert.equal(oidcCheck(url, new Error("HTTP 404"), "r").mark, "fail");
});

test("sign-in: some way in, and an administrator", () => {
  const base = { mailMode: "disabled", providers: [], extensions: [], teamShelves: "on" };
  const marks = (facts: Partial<Parameters<typeof signInChecks>[0]>) =>
    signInChecks({ ...base, passwordAccounts: 0, companyAdmins: 0, ...facts }).map((check) => check.mark);
  assert.deepEqual(marks({}), ["fail", "fail"]);
  assert.deepEqual(marks({ mailMode: "smtp", companyAdmins: 1 }), ["ok", "ok"]);
  // A cloud for many companies: admins belong to organisations, none is missing.
  assert.deepEqual(marks({ mailMode: "smtp", teamShelvesScope: "organisation" }), ["ok", "info"]);
  assert.deepEqual(marks({ providers: ["oidc"], companyAdmins: 1, teamShelves: "off" }), ["ok", "ok", "warn"]);
  assert.deepEqual(marks({ passwordAccounts: 2, companyAdmins: 1 }), ["warn", "ok"]);
  // The database was unreachable: only the configuration is judged.
  assert.deepEqual(marks({ mailMode: "smtp", companyAdmins: null, passwordAccounts: null }), ["ok"]);
});

test("the report: marks, hints, Russian summary and the exit status", () => {
  const checks: Check[] = [
    { mark: "ok", title: "A", detail: "да" },
    { mark: "fail", title: "B", detail: "нет", hint: "сделайте так" },
    { mark: "warn", title: "C" },
    { mark: "info", title: "D", detail: "x" },
  ];
  const text = render(checks);
  assert.match(
    text,
    /^✓ A — да\n✗ B — нет\n {4}→ сделайте так\n! C\n· D — x\n\nНе готово: 1 проблема, предупреждений: 1\.$/,
  );
  assert.equal(exitCode(checks), 1);
  assert.equal(exitCode(checks.filter((check) => check.mark !== "fail")), 0);
  assert.match(render([]), /Всё в порядке\./);
});

test("secrets never reach the output", () => {
  const out = scrub(
    "auth failed for user polka_runtime with s3cr3t-value at postgres://polka_runtime:hunter22@db:5432/x",
    ["s3cr3t-value", undefined, ""],
  );
  assert.doesNotMatch(out, /s3cr3t-value|hunter22/);
  assert.match(out, /postgres:\/\/polka_runtime:…@db/);
  assert.ok(scrub("x".repeat(1000), []).length <= 301);
});

test("the command refuses unknown arguments", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/admin.ts", "ops", "doctor", "--nope"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /ops doctor/);
});
