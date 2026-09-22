export function safeNext(value: string | null) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20]/.test(value)
  )
    return null;
  try {
    const base = "https://polka.invalid";
    const parsed = new URL(value, base);
    if (parsed.origin !== base) return null;
    const path = parsed.pathname + parsed.search + parsed.hash;
    // Dot segments normalise "/.//host" to "//host", a protocol-relative URL
    // that would leave Полка, so the result is checked again, not only the input.
    return path.startsWith("//") ? null : path;
  } catch {
    return null;
  }
}

/** One return destination for both login links on a protected page. */
export function authReturnTo(location: {
  pathname: string;
  search: string;
  hash: string;
}) {
  const query = new URLSearchParams(location.search);
  const explicit = safeNext(query.get("next"));
  if (explicit) return explicit;
  if (
    location.pathname === "/signup" ||
    (location.pathname === "/" && query.has("login"))
  )
    return "/start";
  // A share link carries its token in the fragment so it never reaches a
  // server; putting it into ?next= would send it to every proxy log.
  if (location.pathname === "/s") return "/start";
  return (
    safeNext(location.pathname + location.search + location.hash) || "/start"
  );
}
