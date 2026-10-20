// The T-API statement as the bank answers it (business.tbank.ru/openapi):
// accounts, and a statement page with «from», «to», «limit» and «cursor».
// Shared by the stand's bank (fin-systems) and a company's own APIs
// (company-apis).

export const bankAccounts = (accounts) =>
  accounts.map((a) => ({
    accountNumber: a.account,
    name: "Расчётный счёт",
    status: "Active",
    currency: "643",
    bankBik: a.bik,
    accountType: "Current",
    mainFlag: "Y",
  }));

/** [status, body] of GET /api/v1/statement over all operations of the account. */
export function statementPage(all, account, params) {
  if (params.get("accountNumber") !== account) return [404, { errorMessage: "счёт не найден" }];
  if (!params.get("from")) return [400, { errorMessage: "from is required" }];
  const from = params.get("from").slice(0, 10);
  const to = (params.get("to") ?? "9999-12-31").slice(0, 10);
  const ops = all.filter((o) => o.docDate >= from && o.docDate < to);
  const limit = Math.min(Number(params.get("limit") ?? 1000), 5000);
  const offset = Number(Buffer.from(params.get("cursor") ?? "MA==", "base64").toString() || 0);
  const page = ops.slice(offset, offset + limit);
  const next = offset + limit < ops.length ? Buffer.from(String(offset + limit)).toString("base64") : undefined;
  return [200, { operations: page, ...(next ? { nextCursor: next } : {}) }];
}
