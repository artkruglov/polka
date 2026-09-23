import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingPlans } from "../apps/web/src/pages/pricing/plans.tsx";
import { LegalLinks } from "../apps/web/src/widgets/navigation/index.tsx";
import {
  SOURCE_LICENSE,
  SOURCE_URL,
} from "../apps/web/src/shared/lib/project-links.ts";

const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const read = (path: string) => readFileSync(path, "utf8");

test("LICENSE is the unmodified GNU AGPL-3.0 text", () => {
  const license = read("LICENSE");
  assert.match(license, /^\s+GNU AFFERO GENERAL PUBLIC LICENSE\n\s+Version 3, 19 November 2007\n/);
  assert.match(license, /13\. Remote Network Interaction; Use with the GNU General Public License\./);
  // SHA-256 of https://www.gnu.org/licenses/agpl-3.0.txt.
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0",
  );
  assert.equal(JSON.parse(read("package.json")).license, "AGPL-3.0-only");
  assert.equal(SOURCE_LICENSE, "AGPL-3.0");
});

test("every page shell offers the source code and the page for companies", () => {
  const html = render(React.createElement(LegalLinks));
  // Before /api/capabilities answers, the upstream repository is the link.
  assert.ok(
    html.includes(
      `<a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">Открытый код на GitHub</a>`,
    ),
  );
  assert.match(html, /<a href="\/enterprise">Для компаний<\/a>/);
  // The pages outside AppShell carry the footer themselves.
  for (const page of ["away", "mail-off"])
    assert.match(read(`apps/web/src/pages/${page}/index.tsx`), /<LegalLinks \/>/, page);
});

test("/pricing: the cloud, self-hosting under the AGPL and a commercial license", () => {
  const html = render(React.createElement(PricingPlans));
  assert.equal((html.match(/<article>/g) ?? []).length, 3);
  for (const heading of [
    "Облако polochka.app",
    "Своя установка",
    "Коммерческая лицензия",
  ])
    assert.ok(html.includes(`<h2>${heading}</h2>`), heading);
  assert.match(html, /Бесплатно на время пилота/);
  assert.match(html, /Бесплатно по AGPL-3\.0/);
  assert.ok(html.includes(`href="${SOURCE_URL}"`));
  assert.ok(html.includes(`href="${SOURCE_URL}/blob/main/deploy/hosted/README.md"`));
  assert.match(html, /href="mailto:hello@polochka\.app\?subject=[^"]+"[^>]*>Написать/);
  // The commercial license and the new call to action lead to /enterprise.
  assert.match(html, /href="\/enterprise\?interest=commercial-license#request"[^>]*>Оставить заявку/);
  assert.match(html, /href="\/enterprise"[^>]*>Для компаний/);
  // No price is invented.
  assert.doesNotMatch(html, /₽|\$|руб\.|€/);
  const routes = read("apps/web/src/app/routing/index.tsx");
  assert.match(routes, /path === "\/pricing"\) return <Pricing \/>/);
  assert.match(read("apps/server/frontend.ts"), /path === "\/pricing" \|\|/);
  assert.match(read("apps/web/src/pages/landing/index.tsx"), /href="\/enterprise"/);
});

function sourceUrlConfig(value: string | undefined) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    DATABASE_URL: "postgres://runtime:password@example.invalid:5432/polka",
    S3_ENDPOINT: "https://objects.example.invalid",
    S3_ACCESS_KEY: "synthetic-access",
    S3_SECRET_KEY: "synthetic-storage-secret",
    S3_BUCKET: "synthetic-bucket",
    LINK_KEY: "a".repeat(64),
    APP_ORIGIN: "https://app.example.invalid",
  };
  if (value !== undefined) env.SOURCE_URL = value;
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import('./apps/server/config.ts').then(({config}) => console.log(JSON.stringify(config.SOURCE_URL)))",
    ],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000 },
  );
}

test("SOURCE_URL defaults to the upstream repository and must be https", () => {
  for (const unset of [undefined, ""]) {
    const result = sourceUrlConfig(unset);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), "https://github.com/artkruglov/polka");
  }
  const fork = sourceUrlConfig("https://git.example.org/team/polka");
  assert.equal(fork.status, 0, fork.stderr);
  assert.equal(JSON.parse(fork.stdout), "https://git.example.org/team/polka");
  for (const bad of ["http://git.example.org/polka", "not a url", "javascript:alert(1)"])
    assert.notEqual(sourceUrlConfig(bad).status, 0, bad);
});
