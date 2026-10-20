// A query of 1C's standard OData interface over a list of rows, for the
// stand's stand-ins (fin-systems, company-apis): $filter with eq, ne, gt, ge,
// lt, le joined by «and» ('text', numbers, true/false, datetime'…'), $select,
// $orderby, $top, $skip. Enough of what 1C answers to check a client; not
// all of OData.
const OPS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  ge: (a, b) => a >= b,
  lt: (a, b) => a < b,
  le: (a, b) => a <= b,
};

function literal(raw) {
  const s = raw.trim();
  const dt = /^datetime'([^']+)'$/i.exec(s);
  if (dt) return dt[1];
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "true" || s === "false") return s === "true";
  if (s === "null") return null;
  return Number(s);
}

export function filter(rows, expr) {
  if (!expr) return rows;
  const terms = expr.split(/\s+and\s+/i).map((t) => {
    const m = /^(\S+)\s+(eq|ne|gt|ge|lt|le)\s+(.+)$/i.exec(t.trim());
    if (!m) throw new Error(`$filter: не понимаю «${t}»`);
    return [m[1], OPS[m[2].toLowerCase()], literal(m[3])];
  });
  return rows.filter((r) => terms.every(([f, op, v]) => op(r[f] ?? null, v)));
}

/** Rows as 1C would answer them to these search params. */
export function query(rows, params) {
  let out = filter(rows, params.get("$filter"));
  const order = params.get("$orderby");
  if (order) {
    const keys = order.split(",").map((k) => k.trim().split(/\s+/));
    out = [...out].sort((a, b) => {
      for (const [k, dir = "asc"] of keys) {
        const c = String(a[k] ?? "").localeCompare(String(b[k] ?? ""));
        if (c) return dir.toLowerCase() === "desc" ? -c : c;
      }
      return 0;
    });
  }
  const skip = Number(params.get("$skip") ?? 0);
  const top = params.has("$top") ? Number(params.get("$top")) : Infinity;
  out = out.slice(skip, skip + top);
  const select = params.get("$select");
  if (select) {
    const fields = select.split(",").map((f) => f.trim());
    out = out.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])));
  }
  return out;
}
