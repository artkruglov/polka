#!/usr/bin/env node
// A company's own systems as the connectors meet them (connectors/, M7): its
// T-Business bank over T-API and its 1C base over the standard OData
// interface, each behind its own credentials. The firm is the synthetic one
// with real-data quirks (company/exports.mjs realistic); its mail is a real
// IMAP server in the VM (provision.sh connectors), not this process.
//
//   company-apis.mjs --seed 41 --port 7072 --secrets /etc/finance/company-apis.json
//
// secrets: {"tbank": {"token"}, "1c": {"user", "password"}} — the same values
// the company would put into OpenBao for the connectors. No dependencies.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { generate, tapiOperation } from "../company/gen.mjs";
import { odataLedger, realistic } from "../company/exports.mjs";
import { query } from "./odata.mjs";
import { bankAccounts, statementPage } from "./tapi.mjs";

const same = (given, want) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(want));
  return a.length === b.length && timingSafeEqual(a, b);
};

// As a strict 1C publication reads a query: «+» is a plus, not a space.
const strictParams = (search) =>
  new Map(
    search
      .slice(1)
      .split("&")
      .filter(Boolean)
      .map((kv) => {
        const at = kv.indexOf("=");
        return [decodeURIComponent(kv.slice(0, at)), decodeURIComponent(kv.slice(at + 1))];
      }),
  );

/** The server for a firm (realistic(generate(...)).firm) and its secrets. */
export function companyApis(firm, secrets) {
  const bankA = firm.bankA.map((o) => tapiOperation(o, firm.firm, firm.accounts.a));
  const ledger = odataLedger(firm);
  const basic = `Basic ${Buffer.from(`${secrets["1c"].user}:${secrets["1c"].password}`, "utf8").toString("base64")}`;
  return createServer((req, res) => {
    const url = new URL(req.url, "http://company");
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== "GET") return send(405, { error: "только чтение" });
      if (url.pathname.startsWith("/tbank/")) {
        const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!same(token, secrets.tbank.token)) return send(401, { errorMessage: "Unauthorized" });
        if (url.pathname === "/tbank/api/v4/bank-accounts") return send(200, bankAccounts([firm.accounts.a]));
        if (url.pathname === "/tbank/api/v1/statement")
          return send(...statementPage(bankA, firm.accounts.a.account, url.searchParams));
      }
      const odata = /^\/1c\/odata\/standard\.odata\/([^/?]+)$/.exec(url.pathname);
      if (odata) {
        if (!same(req.headers.authorization, basic))
          return send(
            401,
            { "odata.error": { message: { value: "Ошибка аутентификации" } } },
            {
              "www-authenticate": 'Basic realm="1C"',
            },
          );
        const entity = decodeURIComponent(odata[1]);
        if (!ledger[entity])
          return send(404, { "odata.error": { code: "-1", message: { value: `Не найден ресурс ${entity}` } } });
        return send(200, {
          "odata.metadata": `${url.origin}/1c/odata/standard.odata/$metadata#${entity}`,
          value: query(ledger[entity], strictParams(url.search)),
        });
      }
      send(404, { error: "not found" });
    } catch (error) {
      send(400, { "odata.error": { message: { value: String(error.message ?? error) } } });
    }
  });
}

const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const secrets = JSON.parse(await readFile(opt("--secrets", "/etc/finance/company-apis.json"), "utf8"));
  const { firm } = realistic(generate({ seed: Number(opt("--seed", 41)) }));
  const port = Number(opt("--port", 7072));
  companyApis(firm, secrets).listen(port, "127.0.0.1", () =>
    console.log(`${firm.firm.name}: T-API и OData 1С на 127.0.0.1:${port}`),
  );
}
