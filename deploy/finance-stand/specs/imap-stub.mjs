// An IMAP server for the specs: one folder, LOGIN, EXAMINE, UID SEARCH and
// UID FETCH BODY.PEEK[] — what connectors/imap.mjs asks. It keeps every
// command it got, so a spec can see that nothing but reading was asked. In
// the VM the connector meets a real server (dovecot, provision.sh connectors).
import { createServer } from "node:net";

export function imapStub({ user, password, uidvalidity = 1, letters = [] }) {
  const box = { uidvalidity, letters: [...letters], commands: [] };
  const server = createServer((socket) => {
    let buf = "";
    let authed = false;
    socket.write("* OK stub IMAP4rev1 ready\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let eol;
      while ((eol = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        const [, tag, cmd, rest = ""] = /^(\S+) (\S+(?: (?:SEARCH|FETCH))?) ?(.*)$/i.exec(line) ?? [];
        box.commands.push(cmd?.toUpperCase());
        const ok = (text = "done") => socket.write(`${tag} OK ${text}\r\n`);
        const up = cmd?.toUpperCase();
        if (up === "LOGIN") {
          const [, u, p] = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest) ?? [];
          const unq = (s) => s?.replace(/\\(.)/g, "$1");
          if (unq(u) === user && unq(p) === password) ((authed = true), ok("LOGIN completed"));
          else socket.write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`);
        } else if (up === "LOGOUT") {
          socket.write("* BYE\r\n");
          ok();
          socket.end();
        } else if (!authed) socket.write(`${tag} BAD not authenticated\r\n`);
        else if (up === "EXAMINE") {
          socket.write(`* ${box.letters.length} EXISTS\r\n* OK [UIDVALIDITY ${box.uidvalidity}] UIDs valid\r\n`);
          ok("[READ-ONLY] EXAMINE completed");
        } else if (up === "UID SEARCH") {
          const from = Number(/UID (\d+):\*/.exec(rest)?.[1] ?? 1);
          const uids = box.letters.map((l) => l.uid);
          let hit = uids.filter((u) => u >= from);
          if (!hit.length && uids.length) hit = [uids.at(-1)]; // «n:*» always names the last one
          socket.write(`* SEARCH ${hit.join(" ")}\r\n`);
          ok();
        } else if (up === "UID FETCH") {
          const want = rest.split(" ")[0].split(",").map(Number);
          box.letters.forEach((l, i) => {
            if (!want.includes(l.uid)) return;
            socket.write(`* ${i + 1} FETCH (UID ${l.uid} BODY[] {${l.bytes.length}}\r\n`);
            socket.write(l.bytes);
            socket.write(")\r\n");
          });
          ok();
        } else socket.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  return { server, box };
}
