// Renders the browser icons in apps/web/public from apps/web/icons/*.svg with
// headless Chrome (macOS path; set CHROME to override). Outputs are committed:
//   node scripts/gen-icons.mjs
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const src = "apps/web/icons";
const out = "apps/web/public";
const work = mkdtempSync(join(tmpdir(), "polka-icons-"));

// Headless Chrome keeps running after it writes the screenshot, so wait for
// the file and stop it.
async function render(svg, size, file) {
  const page = join(work, `${size}.html`);
  writeFileSync(
    page,
    `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${readFileSync(join(src, svg)).toString("base64")}">`,
  );
  rmSync(file, { force: true });
  const child = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--force-device-scale-factor=1", "--default-background-color=00000000",
    `--user-data-dir=${join(work, `profile-${size}`)}`, `--window-size=${size},${size}`,
    `--screenshot=${file}`, `file://${page}`,
  ], { stdio: "ignore" });
  try {
    for (let i = 0; i < 300; i++) {
      if (existsSync(file) && statSync(file).size > 0) {
        await new Promise((r) => setTimeout(r, 300));
        return readFileSync(file);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Chrome did not render ${file}`);
  } finally {
    child.kill("SIGKILL");
  }
}

// ICO with PNG payloads (supported by every current browser and Windows Vista+).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(([size, png], i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map(([, png]) => png)]);
}

try {
  copyFileSync(join(src, "mark.svg"), join(out, "favicon.svg"));
  const small = [];
  for (const s of [16, 32, 48]) small.push([s, await render("mark.svg", s, join(work, `ico-${s}.png`))]);
  writeFileSync(join(out, "favicon.ico"), ico(small));
  await render("mark.svg", 180, join(out, "apple-touch-icon.png"));
  await render("mark.svg", 192, join(out, "icon-192.png"));
  await render("mark.svg", 512, join(out, "icon-512.png"));
  await render("mark-maskable.svg", 512, join(out, "icon-512-maskable.png"));
  console.log("icons written to", out);
} finally {
  rmSync(work, { recursive: true, force: true });
}
