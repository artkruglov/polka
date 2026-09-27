// The invitation letter to a template library (template-libraries.ts →
// createTemplateLibraryInvitation). A pure function, text only.
//
// Anyone with a claimed shelf can create a library and invite any address,
// so the letter is fixed text: the only words from the inviter are the
// library's name and their login, both trimmed and quoted, and the only
// link is this installation's invitation page. The sender cannot add a
// message. Limits on how many go out are in template-libraries.ts.

export type LibraryInviteMail = { subject: string; text: string };

const ROLE: Record<"reader" | "curator" | "admin", string> = {
  reader: "читать шаблоны",
  curator: "читать и добавлять шаблоны",
  admin: "читать, добавлять шаблоны и управлять участниками",
};

// Control characters and the Unicode line and paragraph separators.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]+", "g");

/** One line, no control characters, at most `max` characters. */
const plain = (value: string, max: number) => {
  const line = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function libraryInviteMail(input: {
  libraryName: string;
  inviter: string;
  role: "reader" | "curator" | "admin";
  /** The invitation page with its secret in the fragment. */
  url: string;
  expiresAt: Date;
  origin: string;
  contact?: string | null;
}): LibraryInviteMail {
  const library = plain(input.libraryName, 80);
  const inviter = plain(input.inviter, 40);
  const until = input.expiresAt.toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
  return {
    subject: "Приглашение в библиотеку шаблонов Полки",
    text: [
      "Приглашение в библиотеку шаблонов Полки",
      "",
      `Участник Полки «${inviter}» приглашает вас в библиотеку «${library}».`,
      `Вы сможете ${ROLE[input.role]}.`,
      "",
      "Принять приглашение:",
      input.url,
      "",
      `Ссылка действует до ${until} (МСК) и сработает только для аккаунта Полки с этим адресом почты.`,
      "Если вы не ждали приглашения — просто проигнорируйте письмо.",
      "",
      "—",
      `Полка · ${input.origin}${input.contact ? ` · ${input.contact}` : ""}`,
      "",
    ].join("\n"),
  };
}
