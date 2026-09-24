// «Похоже, у вас уже есть полка» without tracking (docs/specs/
// SIGN_IN_PROVIDERS.md § 1). After a sign-in this browser remembers, in its
// own localStorage, only the shelf's display name, how the person signed in
// and when: no id, no address. The hint never leaves the browser; a sign-in
// that would open a NEW shelf sends just the flag known=1, and the page asks
// before creating one. Every access is wrapped: a private window or blocked
// storage simply means no hint.
const HINT = "polka:known-shelf";
const METHOD = "polka:sign-in-method";
const FRESH_NOTE = "polka:fresh-shelf-note";
const ENTERED = "polka:entered-by-agent";

export type SignInMethod = "email" | "password" | "yandex" | "vk" | "oidc" | "agent";
export type KnownShelf = {
  displayName: string;
  method: SignInMethod | null;
  at: string;
};

const METHODS: SignInMethod[] = ["email", "password", "yandex", "vk", "oidc", "agent"];

export function knownShelf(): KnownShelf | null {
  try {
    const raw = JSON.parse(localStorage.getItem(HINT) ?? "null");
    if (
      !raw ||
      typeof raw.displayName !== "string" ||
      !raw.displayName ||
      raw.displayName.length > 80 ||
      typeof raw.at !== "string"
    )
      return null;
    return {
      displayName: raw.displayName,
      method: METHODS.includes(raw.method) ? raw.method : null,
      at: raw.at,
    };
  } catch {
    return null;
  }
}

/** How this tab is signing in right now (read once the session appears). */
export function rememberSignInMethod(method: SignInMethod) {
  try {
    sessionStorage.setItem(METHOD, method);
  } catch {
    // No storage: the hint just lacks the method.
  }
}

/**
 * The browser is signed in to `displayName`: keep the hint fresh. Returns
 * whether there was no hint before (a first shelf in this browser).
 */
export function rememberKnownShelf(displayName: string) {
  const previous = knownShelf();
  try {
    const method = sessionStorage.getItem(METHOD) as SignInMethod | null;
    sessionStorage.removeItem(METHOD);
    const hint: KnownShelf = {
      displayName: displayName.slice(0, 80),
      method:
        method && METHODS.includes(method)
          ? method
          : previous?.displayName === displayName
            ? previous.method
            : null,
      at: new Date().toISOString(),
    };
    localStorage.setItem(HINT, JSON.stringify(hint));
  } catch {
    // No storage: nothing to remember.
  }
  return !previous;
}

/** Words for the method: «Яндекс ID», «по почте»… */
export function methodLabel(method: SignInMethod | null) {
  switch (method) {
    case "email":
      return "по почте";
    case "password":
      return "по логину";
    case "yandex":
      return "Яндекс ID";
    case "vk":
      return "VK ID";
    case "oidc":
      return "единый вход компании";
    case "agent":
      return "по ссылке от агента";
    default:
      return null;
  }
}

/** «Уже есть полка? Привяжите этот вход…»: shown once after a first sign-up. */
export function markFreshShelfNote() {
  try {
    sessionStorage.setItem(FRESH_NOTE, "1");
  } catch {
    // No storage: no note.
  }
}

export function takeFreshShelfNote() {
  try {
    const shown = sessionStorage.getItem(FRESH_NOTE) === "1";
    sessionStorage.removeItem(FRESH_NOTE);
    return shown;
  } catch {
    return false;
  }
}

/** «Вы вошли по ссылке от агента …»: the next page shows it once. */
export function rememberEnteredByAgent(clientName: string) {
  try {
    sessionStorage.setItem(ENTERED, clientName.slice(0, 80));
  } catch {
    // No storage: no banner.
  }
}

export function takeEnteredByAgent() {
  try {
    const name = sessionStorage.getItem(ENTERED);
    sessionStorage.removeItem(ENTERED);
    return name;
  } catch {
    return null;
  }
}

/** The phrase that makes an agent hand out a sign-in link. */
export const OPEN_SHELF_PHRASE = "Открой мою Полку";
