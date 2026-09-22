import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { canonicalizeManifest, type BundleManifest } from "../packages/contracts/bundle.ts";
import { buildInlineBundle } from "../apps/server/bundle-inline.ts";

const root = new URL("./fixtures/bundle-corpus/team-report/", import.meta.url);
const sourcePaths = ["index.html", "assets/report.css", "assets/report.js", "assets/mark.svg"];
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function fixture(html?: string) {
  const bytes = new Map<string, Buffer>(
    sourcePaths.map((file) => [file, readFileSync(new URL(file, root))]),
  );
  if (html !== undefined) bytes.set("index.html", Buffer.from(html));
  const manifest = canonicalizeManifest({
    version: 1,
    entrypoint: "index.html",
    runtime: "inline-live-experimental-v1",
    files: sourcePaths.map((path) => {
      const value = bytes.get(path)!;
      return {
        path,
        mime:
          path.endsWith(".html")
            ? "text/html"
            : path.endsWith(".css")
              ? "text/css"
              : path.endsWith(".js")
                ? "text/javascript"
                : "image/svg+xml",
        size: value.length,
        sha256: digest(value),
      };
    }),
    provenance: {
      kind: "file",
      sourceUrl: null,
      capturedAt: "2026-09-20T10:20:30Z",
      attribution: "Original fixture",
      license: "Apache-2.0",
    },
    dependencies: { status: "self-contained", unresolved: [] },
  });
  return { manifest, bytes };
}

function resultForHtml(html: string) {
  const value = fixture(html);
  return buildInlineBundle(value.manifest, value.bytes);
}

test("inlines the team report deterministically without mutating source bytes", () => {
  const value = fixture();
  const before = new Map([...value.bytes].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const first = buildInlineBundle(value.manifest, value.bytes);
  const second = buildInlineBundle(value.manifest, value.bytes);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  if (!first.ok) return;
  assert.equal(first.builderVersion, "bundle-inline-v6");
  assert.equal(first.runtimeProfile, "bundle-inline-experimental-v1");
  assert.deepEqual(first.consumedPaths, sourcePaths.slice().sort());
  assert.match(first.html.toString("utf8"), /<style>/);
  assert.match(first.html.toString("utf8"), /<script>/);
  // The page's own script follows the environment prelude.
  const scripts = [...first.html.toString("utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.match(scripts[0][1], /localStorage/);
  const script = scripts.at(-1)?.[1];
  assert.ok(script);
  assert.equal(script, value.bytes.get("assets/report.js")!.toString("utf8"));
  assert.match(script, /=>/);
  assert.doesNotMatch(script, /&gt;/);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(first.html.toString("utf8"), /data:image\/svg\+xml;base64,/);
  assert.equal(first.sha256, digest(first.html));
  assert.equal(first.size, first.html.length);
  for (const [path, bytes] of before) assert.deepEqual(value.bytes.get(path), bytes, path);
});

test("rejects missing and hash-mismatched resources", () => {
  const missing = fixture();
  missing.bytes.delete("assets/report.js");
  const missingResult = buildInlineBundle(missing.manifest, missing.bytes);
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.path, "assets/report.js");
  const corrupt = fixture();
  corrupt.bytes.set("assets/report.js", Buffer.from("corrupt"));
  const corruptResult = buildInlineBundle(corrupt.manifest, corrupt.bytes);
  assert.equal(corruptResult.ok, false);
  if (!corruptResult.ok) assert.equal(corruptResult.path, "assets/report.js");
});

test("rejects unsupported script modes, raw-text closers, external resources, CSS imports, and escapes", () => {
  for (const html of [
    '<!doctype html><script type="module" src="assets/report.js"></script>',
    '<!doctype html><script src=""></script>',
    '<!doctype html><script type=""></script>',
    "<!doctype html><script>const x = '</script>';</script>",
    '<!doctype html><input type="image" src="assets/mark.svg">',
    '<!doctype html><svg><image href="assets/mark.svg"></image></svg>',
    '<!doctype html><style>@import "evil.css";</style>',
    '<!doctype html><img src="../outside.png">',
  ]) {
    const result = resultForHtml(html);
    assert.equal(result.ok, false, html);
  }
});

test("rejects malformed XML inside SVG and stylesheet attributes that would be dropped", () => {
  const malformed = fixture("<!doctype html><img src=assets/mark.svg>");
  malformed.bytes.set("assets/mark.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'));
  const svg = malformed.manifest.files.find((file) => file.path === "assets/mark.svg")!;
  const malformedManifest = canonicalizeManifest({
    ...malformed.manifest,
    files: malformed.manifest.files.map((file) =>
      file.path === svg.path ? { ...file, size: malformed.bytes.get(svg.path)!.length, sha256: digest(malformed.bytes.get(svg.path)!) } : file,
    ),
  });
  assert.equal(buildInlineBundle(malformedManifest, malformed.bytes).ok, false);
  assert.equal(resultForHtml('<!doctype html><link rel="stylesheet" type="text/plain" id="theme" href="assets/report.css">').ok, false);
});

test("rejects unsupported HTML resource constructs explicitly", () => {
  for (const html of [
    "<!doctype html><iframe src=frame.html></iframe>",
    "<!doctype html><base href=./>",
    '<!doctype html><meta http-equiv="refresh" content="0;url=x">',
    "<!doctype html><img srcset=one.png>",
  ])
    assert.equal(resultForHtml(html).ok, false, html);
});

test("bounds deeply nested HTML and SVG before recursive processing", () => {
  const htmlDepth = 400;
  const deepHtml = `<!doctype html>${"<div>".repeat(htmlDepth)}x${"</div>".repeat(htmlDepth)}`;
  assert.doesNotThrow(() => {
    const result = resultForHtml(deepHtml);
    assert.equal(result.ok, false);
  });

  const value = fixture("<!doctype html><img src=assets/mark.svg>");
  const nestedSvg = `<svg xmlns="http://www.w3.org/2000/svg">${"<g>".repeat(400)}<rect/>${"</g>".repeat(400)}</svg>`;
  const svgBytes = Buffer.from(nestedSvg);
  value.bytes.set("assets/mark.svg", svgBytes);
  const svg = value.manifest.files.find((file) => file.path === "assets/mark.svg")!;
  const manifest = canonicalizeManifest({
    ...value.manifest,
    files: value.manifest.files.map((file) =>
      file.path === svg.path ? { ...file, size: svgBytes.length, sha256: digest(svgBytes) } : file,
    ),
  });
  assert.doesNotThrow(() => {
    const result = buildInlineBundle(manifest, value.bytes);
    assert.equal(result.ok, false);
  });
});

test('CSS local images are embedded in stylesheets and style attributes', () => {
 for(const html of ['<style>body{background:url("assets/mark.svg")}</style><h1>Hello</h1>','<h1 style="background:url(assets/mark.svg);color:red">Hello</h1>']) {
  const {manifest,bytes}=fixture(html);const result=buildInlineBundle(manifest,bytes);
  assert.equal(result.ok,true);if(!result.ok)return;
  assert.match(result.html.toString(),/data:image\/svg\+xml;base64,/);
  assert.ok(result.consumedPaths.includes('assets/mark.svg'));
 }
});
test('CSS external, escaped, missing and active-image references fail closed',()=>{
 for(const reference of ['data:image/svg+xml,evil','../outside.png','missing.png','assets/report.js','assets/mark.svg#fragment','assets/\\6dark.svg']){
  const {manifest,bytes}=fixture(`<style>body{background:url("${reference}")}</style>`);
  assert.equal(buildInlineBundle(manifest,bytes).ok,false,reference);
 }
 const {manifest,bytes}=fixture('<style>body{background:url(assets/mark.svg)}</style>');
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');bytes.set('assets/mark.svg',svg);
 const updated=canonicalizeManifest({...manifest,files:manifest.files.map(f=>f.path==='assets/mark.svg'?{...f,size:svg.length,sha256:digest(svg)}:f)});
 assert.equal(buildInlineBundle(updated,bytes).ok,false);
});

// bundle-inline-v4: markup a chat artifact commonly carries.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1").toString("base64");
const WOFF2 = Buffer.from("wOF2\x00\x01\x00\x00", "latin1").toString("base64");
const WOFF = Buffer.from("wOFF\x00\x01\x00\x00", "latin1").toString("base64");
const INERT_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
).toString("base64");

test("v4 keeps validated data: images and fonts as they are", () => {
  for (const html of [
    `<!doctype html><img src="data:image/png;base64,${PNG}" alt="">`,
    `<!doctype html><img src="data:image/gif;base64,${GIF}" alt="">`,
    `<!doctype html><img src="data:image/svg+xml;base64,${INERT_SVG}" alt="">`,
    `<!doctype html><style>div{background:url("data:image/png;base64,${PNG}")}</style>`,
    `<!doctype html><style>@font-face{font-family:A;src:url(data:font/woff2;base64,${WOFF2}) format("woff2"),url(data:font/woff;base64,${WOFF})}</style>`,
    `<!doctype html><p style="background:url(data:image/png;base64,${PNG})">x</p>`,
  ]) {
    const result = resultForHtml(html);
    assert.equal(result.ok, true, `${html}: ${JSON.stringify(result)}`);
    if (result.ok) assert.match(result.html.toString(), /data:(image|font)\//);
  }
});

test("v4 refuses data: URIs of other types, mislabelled bytes and active SVG", () => {
  const activeSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  ).toString("base64");
  for (const html of [
    `<!doctype html><img src="data:image/png;base64,${Buffer.from("not a png").toString("base64")}">`,
    `<!doctype html><img src="data:image/svg+xml;base64,${activeSvg}">`,
    "<!doctype html><img src=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>\">",
    '<!doctype html><img src="data:text/html;base64,PGI+">',
    `<!doctype html><img src="data:image/png;base64,${PNG.slice(0, -2)}">`,
    `<!doctype html><img src="data:image/png;charset=utf-8;base64,${PNG}">`,
    `<!doctype html><img src="data:font/woff2;base64,${WOFF2}">`,
    '<!doctype html><style>div{background:url(data:text/html;base64,PGI+)}</style>',
    `<!doctype html><style>div{background:url(data:application/javascript;base64,${PNG})}</style>`,
  ])
    assert.equal(resultForHtml(html).ok, false, html);
});

test("v4 accepts fragment and absolute web links but no script or relative ones", () => {
  for (const html of [
    '<!doctype html><a href="#top">top</a>',
    '<!doctype html><a href="#">top</a>',
    '<!doctype html><a href="https://example.org/a?b=c#d">x</a>',
    '<!doctype html><a href="http://example.org">x</a>',
    '<!doctype html><a href="mailto:owner@example.org">x</a>',
    '<!doctype html><svg><symbol id="i"><path d="M0 0"/></symbol><use href="#i"/><use xlink:href="#i"/></svg>',
  ]) {
    const result = resultForHtml(html);
    assert.equal(result.ok, true, `${html}: ${JSON.stringify(result)}`);
  }
  for (const html of [
    '<!doctype html><a href="javascript:alert(1)">x</a>',
    '<!doctype html><a href=" JavaScript:alert(1)">x</a>',
    '<!doctype html><a href="java\tscript:alert(1)">x</a>',
    '<!doctype html><a href="vbscript:x">x</a>',
    '<!doctype html><a href="data:text/html,x">x</a>',
    '<!doctype html><a href="other.html">x</a>',
    '<!doctype html><a href="//example.org">x</a>',
    '<!doctype html><svg><use href="sprite.svg#i"/></svg>',
    '<!doctype html><svg><use href="https://example.org/s.svg#i"/></svg>',
    '<!doctype html><area href="https://example.org">',
  ])
    assert.equal(resultForHtml(html).ok, false, html);
});

test("v4 accepts CSS escapes in strings and identifiers, not in functions or at-rules", () => {
  for (const html of [
    '<!doctype html><style>q::before{content:"\\201C"}</style>',
    "<!doctype html><style>.md\\:flex{display:flex}</style>",
    "<!doctype html><style>/* \\x */ a{color:red}</style>",
    '<!doctype html><p style="font-family:\'A\\42 C\'">x</p>',
  ]) {
    const result = resultForHtml(html);
    assert.equal(result.ok, true, `${html}: ${JSON.stringify(result)}`);
  }
  for (const html of [
    "<!doctype html><style>a{background:u\\72l(assets/mark.svg)}</style>",
    "<!doctype html><style>a{background:\\75 rl(assets/mark.svg)}</style>",
    "<!doctype html><style>a{background:URL(assets/\\6d ark.svg)}</style>",
    '<!doctype html><style>a{background:url("assets/\\6d ark.svg")}</style>',
    '<!doctype html><style>@\\69mport "x.css";</style>',
    '<!doctype html><style>@im\\port "x.css";</style>',
    "<!doctype html><style>a{background:image-\\73 et(x)}</style>",
    "<!doctype html><style>a{width:calc(1px + \\31 px)}</style>",
  ])
    assert.equal(resultForHtml(html).ok, false, html);
});

test("v4 accepts inline classic scripts with async or defer, not modules or JSX", () => {
  for (const html of [
    "<!doctype html><script async>1</script>",
    "<!doctype html><script defer>1</script>",
  ])
    assert.equal(resultForHtml(html).ok, true, html);
  for (const html of [
    '<!doctype html><script async src="assets/report.js"></script>',
    '<!doctype html><script defer src="assets/report.js"></script>',
    '<!doctype html><script type="module">1</script>',
    '<!doctype html><script type="text/babel">1</script>',
  ])
    assert.equal(resultForHtml(html).ok, false, html);
});

// bundle-inline-v6: what a chat artifact carries that the viewer could never
// load is left out with a warning instead of refusing the page.
test("v6 drops link hints, remote stylesheets, fonts and images with warnings", () => {
  const result = resultForHtml(
    '<!doctype html><html><head>' +
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="icon" href="favicon.ico">' +
      '<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet" crossorigin>' +
      '<link rel="stylesheet" href="https://cdn.example.org/lib.css" integrity="sha384-x">' +
      '<style>@import url("https://fonts.googleapis.com/css2?family=Roboto");' +
      "body{font-family:Inter,sans-serif;background:url(https://example.org/bg.png) #fafafa}h1{color:red}</style>" +
      '</head><body><h1 style="background-image:url(//example.org/x.png)">Hi</h1>' +
      '<img src="https://images.example.org/a.jpg" alt="Photo" width="20"></body></html>',
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const html = result.html.toString();
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /https?:\/\/|\/\/example/);
  assert.match(html, /<img alt="Photo" width="20">/);
  assert.match(html, /h1\{color:red\}/);
  assert.equal(result.warnings.length, 5, result.warnings.join(" | "));
  assert.ok(result.warnings.some((warning) => warning.includes("fonts.googleapis.com")));
  assert.ok(result.warnings.some((warning) => warning.includes("внешние изображения (1)")));
  // The same remote references stay refused in a stylesheet the builder
  // generated itself, and a local-but-missing file is still an error.
  assert.equal(resultForHtml('<!doctype html><link rel="alternate" href="https://example.org/feed">').ok, false);
  assert.equal(resultForHtml('<!doctype html><link rel="stylesheet" href="missing.css">').ok, false);
});

test("v6 keeps same-document url(#id) references in CSS and inert SVG images", () => {
  for (const html of [
    '<!doctype html><style>.a{fill:url(#g)}.b{filter:url("#glow")}.c{clip-path:url(#clip)}</style><svg><defs><linearGradient id="g"></linearGradient></defs><rect class="a"/></svg>',
    '<!doctype html><svg><rect style="fill:url(#g);mask:url(#m)"/></svg>',
  ]) {
    const result = resultForHtml(html);
    assert.equal(result.ok, true, `${html}: ${JSON.stringify(result)}`);
    if (result.ok) assert.match(result.html.toString(), /url\((?:"|&quot;)#g(?:"|&quot;)\)/);
  }
  for (const reference of ["#", "#a b", "#x)", "other.svg#g"])
    assert.equal(resultForHtml(`<!doctype html><style>.a{fill:url("${reference}")}</style>`).ok, false, reference);
});

const svgImage = (svg: string) => {
  const value = fixture("<!doctype html><img src=assets/mark.svg>");
  const bytes = Buffer.from(svg);
  value.bytes.set("assets/mark.svg", bytes);
  const manifest = canonicalizeManifest({
    ...value.manifest,
    files: value.manifest.files.map((file) =>
      file.path === "assets/mark.svg" ? { ...file, size: bytes.length, sha256: digest(bytes) } : file,
    ),
  });
  return buildInlineBundle(manifest, value.bytes);
};

test("v6 accepts presentational SVG images (icons, gradients, text), not active ones", () => {
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 0h24v24z"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g" x1="0" x2="1" gradientTransform="rotate(45)"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f" stop-opacity=".5"/></linearGradient><clipPath id="c"><circle r="5"/></clipPath></defs><g transform="translate(1 1)" clip-path="url(#c)"><rect width="10" height="10" fill="url(#g)" stroke-dasharray="2 1"/></g><text x="1" y="9" font-size="3" text-anchor="start">Tom &amp; Jerry &#8212;</text></svg>',
  ]) {
    const result = svgImage(svg);
    assert.equal(result.ok, true, `${svg}: ${JSON.stringify(result)}`);
  }
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.org/p)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u&#114;l(https://example.org/p)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="x()"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="https://example.org/"><rect/></svg>',
    '<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
  ])
    assert.equal(svgImage(svg).ok, false, svg);
});

test("v6 keeps inline data blocks (shaders, JSON) and refuses them with src", () => {
  for (const html of [
    '<!doctype html><script type="x-shader/x-vertex" id="vs">void main(){gl_Position=vec4(0.);}</script>',
    '<!doctype html><script type="application/ld+json">{"@type":"Thing"}</script>',
    '<!doctype html><script type="application/json" id="data">[1,2]</script>',
  ]) {
    const result = resultForHtml(html);
    assert.equal(result.ok, true, `${html}: ${JSON.stringify(result)}`);
    // Data blocks run nothing, so they get no environment prelude.
    if (result.ok) assert.doesNotMatch(result.html.toString(), /localStorage/);
  }
  for (const html of [
    '<!doctype html><script type="x-shader/x-vertex" src="assets/report.js"></script>',
    '<!doctype html><script type="speculationrules">{}</script>',
  ])
    assert.equal(resultForHtml(html).ok, false, html);
});

test("v6 gives plain-script pages the environment prelude before their first script", () => {
  for (const html of [
    '<!doctype html><html><head><meta charset="utf-8"><title>T</title><script>localStorage.setItem("a","1")</script></head><body></body></html>',
    '<!doctype html><button onclick="alert(1)">x</button>',
  ]) {
    const result = resultForHtml(html);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) continue;
    const page = result.html.toString();
    const prelude = page.indexOf('Object.defineProperty(window,name,{value:memory()');
    assert.ok(prelude > 0, page.slice(0, 300));
    assert.ok(prelude > page.indexOf("<title>"), "after meta and title");
    const firstScript = page.indexOf('localStorage.setItem("a"');
    if (firstScript >= 0) assert.ok(prelude < firstScript);
  }
  // A script-free page is unchanged by the prelude.
  const plain = resultForHtml("<!doctype html><p>Hi</p>");
  assert.equal(plain.ok && plain.html.toString().includes("<script"), false);
});
