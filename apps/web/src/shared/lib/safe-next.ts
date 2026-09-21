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
    return parsed.origin === base
      ? parsed.pathname + parsed.search + parsed.hash
      : null;
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
  return (
    safeNext(location.pathname + location.search + location.hash) || "/start"
  );
}
