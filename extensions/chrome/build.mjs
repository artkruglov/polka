#!/usr/bin/env node
// Builds the «На Полку» Chrome extension: extensions/chrome/dist (load it
// unpacked) and extensions/chrome/na-polku-<version>.zip (the upload for the
// Chrome Web Store). Only esbuild and Node's own zlib; the zip and the icons
// are written here, byte-for-byte reproducible for the same sources.
//
//   npm run ext:build
import { build } from "esbuild";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "icons"), { recursive: true });

const common = {
  bundle: true,
  target: "chrome116",
  charset: "utf8",
  legalComments: "none",
  logLevel: "warning",
  // Readable output: reviewers of the store listing read the shipped code.
  minify: false,
};
// Content scripts and injected files are classic scripts: one IIFE each.
await build({
  ...common,
  format: "iife",
  entryPoints: {
    "extract-page": join(src, "extract/page.ts"),
    "extract-frame": join(src, "extract/frame.ts"),
    "page-button": join(src, "content/page-button.ts"),
    bridge: join(src, "content/bridge.ts"),
  },
  outdir: dist,
});
// The service worker and the extension pages are modules.
await build({
  ...common,
  format: "esm",
  entryPoints: {
    background: join(src, "background.ts"),
    popup: join(src, "ui/popup.ts"),
    options: join(src, "ui/options.ts"),
  },
  outdir: dist,
});
for (const file of ["popup.html", "options.html", "ui.css"])
  copyFileSync(join(src, "ui", file), join(dist, file));
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// --- Icons: a blue tile with two shelves and a book, drawn at 4× and averaged.
function png(size) {
  const scale = 4;
  const big = size * scale;
  const inside = (x, y) => {
    const u = x / big;
    const v = y / big;
    const r = 0.2;
    const cx = Math.min(Math.max(u, r), 1 - r);
    const cy = Math.min(Math.max(v, r), 1 - r);
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
  };
  const white = (x, y) => {
    const u = x / big;
    const v = y / big;
    const shelf = (top) => u >= 0.18 && u <= 0.82 && v >= top && v <= top + 0.075;
    const book = (left, top, width) => u >= left && u <= left + width && v >= top && v <= 0.52;
    return shelf(0.52) || shelf(0.76) || book(0.26, 0.24, 0.1) || book(0.4, 0.3, 0.1) || book(0.54, 0.2, 0.09);
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++) {
          const px = x * scale + sx + 0.5;
          const py = y * scale + sy + 0.5;
          if (!inside(px, py)) continue;
          const [cr, cg, cb] = white(px, py) ? [255, 255, 255] : [47, 91, 211];
          r += cr; g += cg; b += cb; a += 255;
        }
      const n = scale * scale;
      const covered = a / 255 || 1;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = Math.round(r / covered);
      raw[offset + 1] = Math.round(g / covered);
      raw[offset + 2] = Math.round(b / covered);
      raw[offset + 3] = Math.round(a / n);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const size of [16, 32, 48, 128])
  writeFileSync(join(dist, "icons", `icon-${size}.png`), png(size));

// --- Zip (stored with deflate, fixed timestamps: reproducible).
function files(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
}
function zip(paths) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const path of paths) {
    const name = Buffer.from(relative(dist, path).split("\\").join("/"), "utf8");
    const data = readFileSync(path);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time 00:00
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(paths.length, 8);
  end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const archive = join(root, `na-polku-${manifest.version}.zip`);
const shipped = files(dist);
writeFileSync(archive, zip(shipped));
console.log(
  `На Полку ${manifest.version}: ${relative(process.cwd(), dist)} (${shipped.length} files), ${relative(process.cwd(), archive)}`,
);
