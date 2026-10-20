// Letters as a mailbox exports them (.mbox, .eml) and the files they carry:
// MIME multipart, base64 and quoted-printable, encoded file names. What the
// audit wants from mail is only the attachments; a letter's words are data
// and decide nothing. A writer for the specs' fixtures. No dependencies.

const latin1 = (buf) => buf.toString("latin1");

function headersOf(text) {
  const out = {};
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return out;
}

const charsetDecode = (bytes, charset = "utf-8") => {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^cp-?1251$/, "windows-1251")).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

function qp(s) {
  const bytes = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3)))
      (bytes.push(parseInt(t.slice(i + 1, i + 3), 16)), (i += 2));
    else bytes.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

/** «=?utf-8?B?…?=» and «=?windows-1251?Q?…?=» in a header. */
export function words(s = "") {
  return s
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, data) =>
      charsetDecode(enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : qp(data.replace(/_/g, " ")), cs),
    );
}

const param = (header = "", name) => {
  // RFC 2231 first: filename*=utf-8''%D0%A3%D0%9F%D0%94.xml
  const ext = header.match(new RegExp(`${name}\\*=([^']*)'[^']*'([^;]+)`, "i"));
  if (ext) {
    const bytes = Buffer.from(
      ext[2].trim().replace(/%([0-9A-F]{2})|./gi, (c, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : c)),
      "latin1",
    );
    return charsetDecode(bytes, ext[1] || "utf-8");
  }
  const m = header.match(new RegExp(`${name}="?([^";]+)"?`, "i"));
  return m ? words(m[1].trim()) : "";
};

function body(raw, h) {
  const enc = (h["content-transfer-encoding"] ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(latin1(raw).replace(/\s+/g, ""), "base64");
  if (enc === "quoted-printable") return qp(latin1(raw));
  return raw;
}

function split(buf) {
  const s = latin1(buf);
  const at = s.search(/\r?\n\r?\n/);
  if (at < 0) return { h: headersOf(s), raw: Buffer.alloc(0) };
  const sep = s.slice(at).match(/^\r?\n\r?\n/)[0].length;
  return { h: headersOf(s.slice(0, at)), raw: buf.subarray(at + sep) };
}

function parts(buf, out) {
  const { h, raw } = split(buf);
  const type = h["content-type"] ?? "text/plain";
  if (/^multipart\//i.test(type)) {
    const boundary = param(type, "boundary");
    const chunks = latin1(raw).split(
      new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\r?\\n?`),
    );
    for (const c of chunks.slice(1)) if (c.trim()) parts(Buffer.from(c, "latin1"), out);
    return out;
  }
  const name = param(h["content-disposition"], "filename") || param(type, "name");
  const data = body(raw, h);
  if (name || /attachment/i.test(h["content-disposition"] ?? ""))
    out.attachments.push({ name: name || "без имени", type: type.split(";")[0].trim(), bytes: data });
  else if (/^text\/plain/i.test(type) && !out.text) out.text = charsetDecode(data, param(type, "charset") || "utf-8");
  return out;
}

/** One letter: from, subject, date, text, attachments [{name, type, bytes}]. */
export function readEml(buf) {
  const { h } = split(buf);
  const m = parts(buf, { attachments: [], text: "" });
  return {
    from: words(h.from),
    subject: words(h.subject),
    date: h.date ?? "",
    text: m.text,
    attachments: m.attachments,
  };
}

/** The letters of an .mbox file («From » lines between them). */
export function readMbox(buf) {
  const s = latin1(buf);
  const starts = [...s.matchAll(/^From .*$/gm)].map((m) => m.index);
  if (!starts.length) return [readEml(buf)];
  return starts.map((a, i) => {
    const from = s.indexOf("\n", a) + 1;
    const text = s.slice(from, starts[i + 1] ?? s.length).replace(/^>(>*From )/gm, "$1");
    return readEml(Buffer.from(text, "latin1"));
  });
}

// ---- writer for fixtures

const b64 = (bytes) => Buffer.from(bytes).toString("base64").replace(/.{76}/g, "$&\r\n");
const word = (s) => `=?utf-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** A letter with attachments, as an .eml would hold it. */
export function writeEml({ from, to, subject, date, text, attachments = [] }, n = 1) {
  const boundary = `----=_stand_${n}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${word(subject)}`,
    `Date: ${new Date(`${date}T10:00:00+03:00`).toUTCString()}`,
    `Message-ID: <${n}@stand.test>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Buffer.from(text, "utf8")),
  ];
  for (const a of attachments)
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.type}; name="${word(a.name)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${word(a.name)}"`,
      "",
      b64(a.bytes),
    );
  lines.push(`--${boundary}--`, "");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

/** Several letters as one .mbox. */
export function writeMbox(letters) {
  return Buffer.concat(
    letters.map((l, i) =>
      Buffer.concat([
        Buffer.from(
          `From ${l.from.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1] ?? "x"} ${new Date(`${l.date}T10:00:00Z`).toUTCString()}\r\n`,
          "latin1",
        ),
        writeEml(l, i + 1),
        Buffer.from("\r\n"),
      ]),
    ),
  );
}

/** A letter as it came from a server, as one entry of an .mbox (mboxrd:
 *  a body line «From …» gets one more «>», readMbox takes it off). */
export function mboxEntry(bytes, { from = "connector", date = new Date() } = {}) {
  const text = Buffer.from(bytes)
    .toString("latin1")
    .replace(/^(>*From )/gm, ">$1");
  return Buffer.from(`From ${from} ${date.toUTCString()}\r\n${text}${text.endsWith("\n") ? "" : "\r\n"}\r\n`, "latin1");
}
