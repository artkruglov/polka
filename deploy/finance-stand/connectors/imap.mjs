// A mailbox over IMAP, read only: the box a company set aside for documents
// (docs@…) or the one its rule forwards letters with attachments to — never
// the bookkeeper's own box. The folder is opened with EXAMINE, letters are
// taken with BODY.PEEK[]: nothing is marked read, moved or deleted. Only
// letters after the last UID taken come; a new UIDVALIDITY means the server
// renumbered the folder, and everything is taken again.
//
// imaps:// (TLS, port 993) to anywhere, imap:// only to this machine.
// No dependencies.
import { connect as plain } from "node:net";
import { connect as tls } from "node:tls";
import { caOf, secureOnly } from "./net.mjs";

const MAX_LETTER = 30 * 1024 * 1024;

function session(socket) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let failed = null;
  const pump = () => waiting?.();
  socket.on("data", (c) => ((buf = Buffer.concat([buf, c])), pump()));
  socket.on("error", (e) => ((failed = e), pump()));
  socket.on("close", () => ((failed ??= new Error("сервер закрыл соединение")), pump()));

  // One response item: a line, with each {n} literal cut out into `literals`.
  async function item() {
    let text = "";
    const literals = [];
    for (;;) {
      let eol;
      while ((eol = buf.indexOf("\r\n")) < 0) await more();
      const line = buf.subarray(0, eol).toString("latin1");
      buf = buf.subarray(eol + 2);
      const lit = /\{(\d+)\}$/.exec(line);
      if (!lit) return { text: text + line, literals };
      const n = Number(lit[1]);
      if (n > MAX_LETTER) throw new Error(`письмо больше ${MAX_LETTER >> 20} МБ`);
      while (buf.length < n) await more();
      literals.push(Buffer.from(buf.subarray(0, n)));
      buf = buf.subarray(n);
      text += `${line.slice(0, lit.index)}\0${literals.length - 1}\0`;
    }
  }
  const more = () =>
    new Promise((resolve, reject) => {
      if (failed) return reject(failed);
      waiting = () => ((waiting = null), failed ? reject(failed) : resolve());
    });

  let n = 0;
  /** Untagged items of a command, or an error with the server's words. */
  async function command(line, secret = false) {
    const tag = `f${++n}`;
    socket.write(`${tag} ${line}\r\n`);
    const items = [];
    for (;;) {
      const it = await item();
      if (it.text.startsWith(`${tag} `)) {
        const [, status, rest] = /^\S+ (\S+) ?(.*)$/.exec(it.text);
        if (status !== "OK") throw new Error(`IMAP ${secret ? "LOGIN" : line.split(" ")[0]}: ${status} ${rest}`.trim());
        return items;
      }
      items.push(it);
    }
  }
  return { item, command };
}

const quoted = (s) => {
  if (/[\r\n\0]/.test(s)) throw new Error("в логине или пароле перевод строки");
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
};

/** Letters after `after` ({uidvalidity, uid}); returns {uidvalidity, uid, letters: [{uid, bytes}]}. */
export async function fetchNew({
  url,
  user,
  password,
  mailbox = "INBOX",
  ca,
  after = {},
  max = 500,
  timeout = 60_000,
}) {
  const u = secureOnly(url, "imap:");
  const port = Number(u.port || (u.protocol === "imaps:" ? 993 : 143));
  const root = await caOf(ca);
  const socket =
    u.protocol === "imaps:"
      ? tls({ host: u.hostname, port, servername: u.hostname, ...(root ? { ca: root } : {}) })
      : plain({ host: u.hostname, port });
  socket.setTimeout(timeout, () => socket.destroy(new Error("timeout")));
  const s = session(socket);
  try {
    const hello = await s.item();
    if (!/^\* (OK|PREAUTH)/.test(hello.text)) throw new Error(`IMAP: ${hello.text}`);
    await s.command(`LOGIN ${quoted(user)} ${quoted(password)}`, true);
    const box = await s.command(`EXAMINE ${quoted(mailbox)}`);
    const uidvalidity = Number(box.map((i) => /UIDVALIDITY (\d+)/.exec(i.text)?.[1]).find(Boolean) ?? 0);
    const from = uidvalidity === after.uidvalidity ? Number(after.uid ?? 0) : 0;
    const found = await s.command(`UID SEARCH UID ${from + 1}:*`);
    // «n:*» names the last letter even when its UID is below n
    const uids = found
      .flatMap((i) =>
        /^\* SEARCH\b/.test(i.text) ? i.text.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : [],
      )
      .filter((x) => x > from)
      .sort((a, b) => a - b)
      .slice(0, max);
    const letters = [];
    for (let i = 0; i < uids.length; i += 20) {
      const part = uids.slice(i, i + 20);
      for (const it of await s.command(`UID FETCH ${part.join(",")} (UID BODY.PEEK[])`)) {
        const uid = Number(/UID (\d+)/.exec(it.text)?.[1]);
        if (/ FETCH /.test(it.text) && it.literals.length && part.includes(uid))
          letters.push({ uid, bytes: it.literals.at(-1) });
      }
    }
    await s.command("LOGOUT").catch(() => {});
    letters.sort((a, b) => a.uid - b.uid);
    return { uidvalidity, uid: letters.at(-1)?.uid ?? from, letters, more: uids.length === max };
  } finally {
    socket.destroy();
  }
}
