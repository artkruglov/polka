/**
 * The one-line phrases the owner copies from a work's page. Each names the
 * work by title and by the address of its page on the shelf: the agent
 * resolves it with polka_get_artifact by that address (the address opens
 * only for the owner and is never a share link). /llms.txt and the skill
 * describe the same phrases (apps/server/agent-discovery.ts).
 */
export const shelfUrl = (origin: string, artifactId: string) =>
  `${origin}/works/${artifactId}`;

export const improvePhrase = (title: string, url: string) =>
  `Открой на Полке работу «${title}» (${url}) и помоги её улучшить.`;

export const updatePhrase = (title: string, url: string) =>
  `Обнови работу «${title}» (${url}).`;

/** notes: COMMENTS_MODE=owner-notes, the owner's own remarks; comments: recipients' comments. */
export const notesPhrase = (
  title: string,
  url: string,
  kind: "notes" | "comments" = "notes",
) =>
  kind === "notes"
    ? `Поправь работу «${title}» (${url}) по моим заметкам на Полке.`
    : `Поправь работу «${title}» (${url}) по комментариям на Полке.`;
