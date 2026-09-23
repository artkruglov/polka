import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AWAY_LINK_TTL_SECONDS,
  awayHref,
  signAwayUrl,
  verifyAwayToken,
  withSignedAwayLinks,
} from "../apps/server/away-links.ts";
import { createApp } from "../apps/server/app.ts";
import { createAccount } from "../apps/server/auth.ts";
import { config } from "../apps/server/config.ts";
import { db } from "../apps/server/db.ts";
import { registerFrontend } from "../apps/server/frontend.ts";
import {
  STATIC_HTML_CSP,
  withAwayLinks,
  withNewTabLinks,
} from "../apps/server/html.ts";
import { s3, sha256 } from "../apps/server/storage.ts";

const BASE = "https://polochka.page/static/token";
// A readable stand-in for the signed link: the rewrite itself is tested here.
const marked = (html: string, base = BASE) =>
  withAwayLinks(Buffer.from(html), base, (url) => `AWAY(${url})`).toString();

test("external http(s) links in <a> and <area> go through /away; nothing else changes", () => {
  const cases: [string, string][] = [
    [
      '<a href="https://e.com/x">x</a>',
      '<a href="AWAY(https://e.com/x)">x</a>',
    ],
    ["<a href='http://e.com'>x</a>", '<a href="AWAY(http://e.com/)">x</a>'],
    ["<a href=https://e.com/>x</a>", '<a href="AWAY(https://e.com/)">x</a>'],
    ['<AREA HREF="HTTPS://E.COM/A">', '<AREA HREF="AWAY(https://e.com/A)">'],
    // Character references are resolved as the browser resolves them.
    [
      '<a href="https://e.com/?a=1&amp;b=2">x</a>',
      '<a href="AWAY(https://e.com/?a=1&b=2)">x</a>',
    ],
    [
      '<a href="&#x68;ttps://e.com">x</a>',
      '<a href="AWAY(https://e.com/)">x</a>',
    ],
    ['<a href="&sol;&sol;e.com">x</a>', '<a href="AWAY(https://e.com/)">x</a>'],
    // Scheme-relative and backslash forms leave the origin too.
    ["<a href=//e.com/p>x</a>", '<a href="AWAY(https://e.com/p)">x</a>'],
    ['<a href="/\\e.com">x</a>', '<a href="AWAY(https://e.com/)">x</a>'],
    // Whitespace and control characters browsers strip.
    [
      '<a href=" \thtt\nps://e.com ">x</a>',
      '<a href="AWAY(https://e.com/)">x</a>',
    ],
    // A quoted ">" does not end the tag.
    [
      '<a title="a > b" href="https://e.com">x</a>',
      '<a title="a > b" href="AWAY(https://e.com/)">x</a>',
    ],
    // SVG links, both spellings.
    [
      '<svg><a xlink:href="https://e.com"><text>x</text></a><a href="https://f.com"/></svg>',
      '<svg><a xlink:href="AWAY(https://e.com/)"><text>x</text></a><a href="AWAY(https://f.com/)"/></svg>',
    ],
    // The static view runs no scripts, so <noscript> content is markup.
    [
      '<noscript><a href="https://e.com">x</a></noscript>',
      '<noscript><a href="AWAY(https://e.com/)">x</a></noscript>',
    ],
    // "--!>" ends a comment; a link after it is live.
    [
      '<!-- x --!><a href="https://e.com">x</a>',
      '<!-- x --!><a href="AWAY(https://e.com/)">x</a>',
    ],
    ['<!--><a href="https://e.com">', '<!--><a href="AWAY(https://e.com/)">'],
    // In SVG a <style> is an ordinary element, and </svg> ends it.
    [
      '<svg><style></svg><a href="https://e.com">x</a></style>',
      '<svg><style></svg><a href="AWAY(https://e.com/)">x</a></style>',
    ],
  ];
  for (const [input, output] of cases)
    assert.equal(marked(input), output, input);

  const untouched = [
    '<a href="mailto:a@e.com">m</a>',
    '<a href="tel:+100">t</a>',
    '<a href="#section">s</a>',
    '<a href="page.html">p</a>',
    '<a href="/static/other">p</a>',
    '<a href="https://polochka.page/elsewhere">same origin</a>',
    '<a href="javascript:alert(1)">j</a>',
    '<a href="data:text/html,x">d</a>',
    "<a href>empty</a>",
    '<a data-href="https://e.com">x</a>',
    '<link rel=stylesheet href="https://e.com/s.css">',
    '<base href="https://e.com/">',
    '<img src="https://e.com/i.png">',
    "<p>href=https://e.com</p>",
    '<!-- <a href="https://e.com"> -->',
    '<script><a href="https://e.com"></script>',
    '<style>a[href="https://e.com"]{}</style>',
    '<textarea><a href="https://e.com"></textarea>',
    '<title><a href="https://e.com"></title>',
    '</p title="<a href=https://e.com>">',
    // Only the first of repeated attributes counts, as in the browser.
    '<a href="#top" href="https://e.com">x</a>',
    // The input ends inside the tag: the browser drops it.
    '<a href="https://e.com"',
  ];
  for (const input of untouched) assert.equal(marked(input), input, input);

  // Every other byte is copied as is, including text that is not UTF-8.
  const page = Buffer.concat([
    Buffer.from("<!doctype html><meta charset=windows-1251><p>"),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0xff, 0xfe]),
    Buffer.from('</p><p>Привет</p><a class=x href="https://e.com">x</a>\r\n'),
  ]);
  const expected = Buffer.concat([
    Buffer.from("<!doctype html><meta charset=windows-1251><p>"),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0xff, 0xfe]),
    Buffer.from(
      '</p><p>Привет</p><a class=x href="AWAY(https://e.com/)">x</a>\r\n',
    ),
  ]);
  assert.deepEqual(
    withAwayLinks(page, BASE, (url) => `AWAY(${url})`),
    expected,
  );
  // Nothing to change: the very same buffer.
  const plain = Buffer.from("<p>no links</p>");
  assert.equal(
    withAwayLinks(plain, BASE, () => "x"),
    plain,
  );
  // On a single-domain install the app origin is the base.
  assert.equal(
    marked(
      '<a href="/works">w</a><a href="https://e.com">e</a>',
      `${config.APP_ORIGIN}/api/view/g/document`,
    ),
    '<a href="/works">w</a><a href="AWAY(https://e.com/)">e</a>',
  );
});

test("the link rewrite stays linear on hostile pages", () => {
  const MB = 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.floor(MB / unit.length));
  const pages = [
    fill('<a href="https://e.com/">'),
    fill("<a href=https://e.com/"),
    fill("<a href=&"),
    "<a href='" + "x".repeat(MB),
    "<a " + fill("href=x "),
    "<a " + fill("h "),
    fill("<div>"),
    fill("<svg>"),
    fill("<!--"),
    fill("<!-- --!"),
    fill("<script>"),
    fill("<style>"),
    fill("</"),
    fill("</a x='"),
    fill("<"),
    fill("<a href=//e.com><b><i>"),
    '<a href="' + "&amp;".repeat(MB / 5) + '">',
    '<a href="https://e.com/' + " ".repeat(MB) + 'x">',
  ];
  for (const page of pages) {
    const started = performance.now();
    withSignedAwayLinks(Buffer.from(page), BASE);
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed < 2_000,
      `${JSON.stringify(page.slice(0, 24))}: ${Math.round(elapsed)} ms`,
    );
  }
});

test("away tokens are signed, expire and name only the signed address", () => {
  const now = Date.now();
  const token = signAwayUrl("https://e.com/path?q=1", now)!;
  assert.deepEqual(verifyAwayToken(token, now), {
    url: "https://e.com/path?q=1",
    host: "e.com",
  });
  assert.equal(
    awayHref("https://e.com/path?q=1", now),
    `${config.APP_ORIGIN}/away#${token}`,
  );
  // Expired.
  assert.equal(
    verifyAwayToken(token, now + (AWAY_LINK_TTL_SECONDS + 1) * 1000),
    null,
  );
  // Forged signature, swapped payload, truncation, junk.
  const [payload, mac] = token.split(".") as [string, string];
  const flipped = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
  assert.equal(verifyAwayToken(`${payload}.${flipped}`, now), null);
  const other = Buffer.from(
    JSON.stringify({
      u: "https://evil.example/",
      e: Math.floor(now / 1000) + 60,
    }),
  ).toString("base64url");
  assert.equal(verifyAwayToken(`${other}.${mac}`, now), null);
  assert.equal(verifyAwayToken(payload, now), null);
  for (const junk of [
    "",
    ".",
    "a.b",
    `${payload}.${mac}x`,
    42,
    null,
    undefined,
  ])
    assert.equal(verifyAwayToken(junk, now), null, String(junk));
  // A MAC made with LINK_KEY itself, not the derived key, does not verify.
  const direct = createHmac("sha256", config.LINK_KEY)
    .update(payload)
    .digest("base64url");
  assert.equal(verifyAwayToken(`${payload}.${direct}`, now), null);
  // Only http(s), no credentials; an unsignable link opens the refusal.
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "mailto:a@e.com",
    "https://user:pass@e.com/",
    `https://e.com/${"x".repeat(5000)}`,
  ]) {
    assert.equal(signAwayUrl(url, now), null, url);
    assert.equal(awayHref(url, now), `${config.APP_ORIGIN}/away`);
  }
  // Look-alike hosts are shown in their ASCII form.
  const idn = signAwayUrl(new URL("https://раураl.com/").href, now)!;
  assert.match(verifyAwayToken(idn, now)!.host, /^xn--/);
});

const app = await createApp();
const origin = config.APP_ORIGIN;
const password = randomBytes(24).toString("hex");
let cookie = "";
let frontendRoot = "";

const call = (method: any, url: string, body?: any, withCookie = true) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      ...(withCookie && cookie ? { cookie } : {}),
      ...(Buffer.isBuffer(body)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    payload: body,
  });

before(async () => {
  frontendRoot = await mkdtemp(join(tmpdir(), "polka-away-"));
  await writeFile(
    join(frontendRoot, "index.html"),
    "<!doctype html><div id=root></div>",
  );
  await registerFrontend(app, frontendRoot);
  const account = await createAccount(
    `away-${randomBytes(5).toString("hex")}`,
    password,
  );
  const login = await call(
    "POST",
    "/api/login",
    { name: account.name, password },
    false,
  );
  assert.equal(login.statusCode, 200, login.body);
  cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
});

after(async () => {
  await app.close();
  await rm(frontendRoot, { recursive: true, force: true });
  await db.end();
  s3.destroy();
});

test("/away is a page, never a redirect; /api/away verifies the token", async () => {
  const token = signAwayUrl("https://e.com/landing")!;
  for (const url of [
    "/away",
    `/away?to=https://evil.example`,
    "/away?url=//evil.example",
  ]) {
    const page = await call("GET", url, undefined, false);
    assert.equal(page.statusCode, 200, url);
    assert.equal(page.headers.location, undefined, url);
    assert.match(page.body, /id=root/);
  }
  const verified = await call("POST", "/api/away", { token }, false);
  assert.equal(verified.statusCode, 200, verified.body);
  assert.deepEqual(verified.json(), {
    url: "https://e.com/landing",
    host: "e.com",
  });
  assert.equal(verified.headers.location, undefined);
  for (const bad of [
    `${token}x`,
    "nonsense",
    signAwayUrl(
      "https://e.com/",
      Date.now() - (AWAY_LINK_TTL_SECONDS + 5) * 1000,
    )!,
  ]) {
    const refused = await call("POST", "/api/away", { token: bad }, false);
    assert.equal(refused.statusCode, 404, bad);
    assert.equal(refused.headers.location, undefined);
  }
  // A browser request from another site is refused before verification.
  const crossSite = await app.inject({
    method: "POST",
    url: "/api/away",
    headers: { origin: "https://evil.example" },
    payload: { token },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(
    (await call("GET", `/api/away?token=${token}`, undefined, false))
      .statusCode,
    404,
  );
});

test("single-domain install keeps the static view on the app origin, with links through /away", async (t) => {
  if (config.HTML_LIVE_ENABLED)
    return t.skip("covered by static-viewer.test.ts");
  const body = Buffer.from(
    '<!doctype html><h1>Page</h1><a href="https://example.org/source">Источник</a><a href="#top">top</a>',
  );
  const start = await call("POST", "/api/uploads", {
    key: randomUUID(),
    title: "Away fixture",
    filename: "away.html",
    mime: "text/html",
    size: body.length,
    sha256: sha256(body),
  });
  assert.equal(start.statusCode, 200, start.body);
  const uploadId = start.json().uploadId;
  assert.equal(
    (await call("PUT", `/api/uploads/${uploadId}/bytes`, body)).statusCode,
    200,
  );
  const saved = (
    await call("POST", `/api/uploads/${uploadId}/finalize`, {})
  ).json();
  assert.equal(saved.htmlProfile, "static");

  const where = await call(
    "POST",
    `/api/revisions/${saved.revisionId}/static-view`,
    {},
  );
  assert.equal(where.statusCode, 200, where.body);
  assert.equal(where.json().url, `/api/revisions/${saved.revisionId}/document`);
  const document = await call("GET", where.json().url);
  assert.equal(document.statusCode, 200, document.body);
  assert.equal(document.headers["content-security-policy"], STATIC_HTML_CSP);
  const away = /href="([^"]+)\/away#([^"]+)"/.exec(document.body);
  assert.ok(away, document.body);
  assert.equal(away[1], config.APP_ORIGIN);
  assert.equal(verifyAwayToken(away[2])!.url, "https://example.org/source");
  assert.equal(
    document.body.replace(away[0], 'href="https://example.org/source"'),
    withNewTabLinks(body).toString(),
  );
  // The app frames its own static view only on a single-domain install.
  assert.match(
    document.headers["content-security-policy"] as string,
    /frame-ancestors 'self'/,
  );
  assert.match(
    where.headers["content-security-policy"] as string,
    /frame-src 'self';/,
  );

  const share = await call("POST", `/api/artifacts/${saved.artifactId}/share`, {
    expectedRevisionId: saved.revisionId,
    expiresInDays: 1,
  });
  assert.equal(share.statusCode, 200, share.body);
  const resolved = await call(
    "POST",
    "/api/resolve",
    { token: new URL(share.json().share.url).hash.slice(1) },
    false,
  );
  const grant = resolved.json().grant;
  const recipient = await app.inject({
    method: "POST",
    url: "/api/view/static-view",
    headers: { origin, authorization: `Bearer ${grant}` },
  });
  assert.equal(recipient.statusCode, 200, recipient.body);
  assert.equal(recipient.json().url, `/api/view/${grant}/document`);
  const recipientDocument = await app.inject({
    method: "GET",
    url: recipient.json().url,
  });
  assert.equal(recipientDocument.statusCode, 200);
  assert.match(
    recipientDocument.body,
    new RegExp(`href="${config.APP_ORIGIN}/away#`),
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/view/static-view",
        headers: { origin, authorization: "Bearer nope" },
      })
    ).statusCode,
    404,
  );
});
