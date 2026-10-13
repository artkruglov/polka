// /privacy and /terms of an installation that is not polochka.app: the
// operator's documents (OPERATOR_NAME, PRIVACY_URL, TERMS_URL,
// OPERATOR_CONTACT), never the cloud's texts in docs/legal.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "../apps/server/app.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { s3 } from "../apps/server/storage.ts";
import {
  parseLegal,
  type CapabilitiesState,
  type InstallationCapabilities,
} from "../apps/web/src/entities/capabilities/useCapabilities.ts";
import { OperatorDocument, legalView } from "../apps/web/src/pages/legal/installation.tsx";

const app = await createApp();
const saved = {
  APP_ORIGIN: config.APP_ORIGIN,
  OPERATOR_NAME: config.OPERATOR_NAME,
  PRIVACY_URL: config.PRIVACY_URL,
  TERMS_URL: config.TERMS_URL,
  OPERATOR_CONTACT: config.OPERATOR_CONTACT,
};
after(async () => {
  Object.assign(config, saved);
  await app.close();
  await db.end();
  s3.destroy();
});

const capabilities = async () => (await app.inject({ method: "GET", url: "/api/capabilities" })).json();

const ready = (legal: InstallationCapabilities["legal"], contact: string | null = null): CapabilitiesState => ({
  status: "ready",
  capabilities: { legal, privacyContact: contact } as InstallationCapabilities,
});

test("capabilities say whose documents /privacy and /terms show", async () => {
  Object.assign(config, { OPERATOR_NAME: undefined, PRIVACY_URL: undefined, TERMS_URL: undefined });
  config.APP_ORIGIN = "https://polochka.app";
  assert.deepEqual((await capabilities()).legal, {
    cloud: true,
    operatorName: null,
    privacyUrl: null,
    termsUrl: null,
  });
  config.APP_ORIGIN = "https://polka.company.test";
  config.OPERATOR_NAME = "ООО «Ромашка»";
  config.PRIVACY_URL = "https://company.test/privacy";
  assert.deepEqual((await capabilities()).legal, {
    cloud: false,
    operatorName: "ООО «Ромашка»",
    privacyUrl: "https://company.test/privacy",
    termsUrl: null,
  });
  config.APP_ORIGIN = saved.APP_ORIGIN;
});

test("polochka.app shows its own texts, as before, even before capabilities answer", () => {
  const cloud = { cloud: true, operatorName: null, privacyUrl: null, termsUrl: null };
  for (const doc of ["privacy", "terms", "bot"] as const) {
    assert.deepEqual(legalView(doc, ready(cloud), true), { kind: "text" });
    assert.deepEqual(legalView(doc, { status: "loading", capabilities: null }, true), { kind: "text" });
  }
});

test("another installation never shows the cloud's documents", () => {
  const own = { cloud: false, operatorName: null, privacyUrl: null, termsUrl: null };
  // Until the installation answers, nothing; a failed answer: the neutral page.
  assert.deepEqual(legalView("privacy", { status: "loading", capabilities: null }, false), { kind: "loading" });
  assert.deepEqual(legalView("terms", { status: "failed", capabilities: null }, false), {
    kind: "operator",
    operatorName: null,
    contact: null,
  });
  assert.deepEqual(legalView("privacy", ready(own, "privacy@company.test"), false), {
    kind: "operator",
    operatorName: null,
    contact: "privacy@company.test",
  });
  // /bot describes the renderer, not the operator: it stays.
  assert.deepEqual(legalView("bot", ready(own), false), { kind: "text" });
  // The operator's own documents: the routes lead there.
  const linked = { ...own, privacyUrl: "https://company.test/privacy", termsUrl: "https://company.test/terms" };
  assert.deepEqual(legalView("privacy", ready(linked), false), {
    kind: "redirect",
    url: "https://company.test/privacy",
  });
  assert.deepEqual(legalView("terms", ready(linked), false), { kind: "redirect", url: "https://company.test/terms" });

  const unnamed = renderToStaticMarkup(
    React.createElement(OperatorDocument, { doc: "privacy", operatorName: null, contact: null }),
  );
  assert.match(unnamed, /<h1>Политика обработки персональных данных<\/h1>/);
  assert.match(
    unnamed,
    /Эта установка Полки принадлежит организации, которая её развернула\. Политику обработки\s+персональных данных и условия использования публикует она\./,
  );
  assert.doesNotMatch(unnamed, /polochka|Круглов|mailto/);
  const named = renderToStaticMarkup(
    React.createElement(OperatorDocument, {
      doc: "terms",
      operatorName: "ООО «Ромашка»",
      contact: "privacy@company.test",
    }),
  );
  assert.match(named, /<h1>Пользовательское соглашение<\/h1>/);
  assert.match(named, /принадлежит ООО «Ромашка»\./);
  assert.match(named, /href="mailto:privacy@company\.test"/);
});

test("the web app takes only https document addresses and a bounded name", () => {
  assert.deepEqual(
    parseLegal({
      cloud: "yes",
      operatorName: "  ",
      privacyUrl: "http://company.test/privacy",
      termsUrl: "javascript:alert(1)",
    }),
    { cloud: false, operatorName: null, privacyUrl: null, termsUrl: null },
  );
  assert.equal(parseLegal({ operatorName: "x".repeat(300) }).operatorName?.length, 200);
  assert.deepEqual(parseLegal(undefined), { cloud: false, operatorName: null, privacyUrl: null, termsUrl: null });
});
