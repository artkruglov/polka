/**
 * «Где вы работаете с ИИ?» on the agents page: the five places a person can
 * be, and the concrete steps for each one. Web ChatGPT and Claude.ai cannot
 * run commands or open /connect, so the person adds the connector by hand;
 * Codex and Claude Code run on the person's machine and do it themselves.
 * The commands are the ones GET /connect serves (apps/server/connect-guide.ts);
 * a test keeps them in step.
 */
import { connectPhrase } from "./connect-phrase.ts";

export const AGENT_CLIENT_IDS = [
  "chatgpt",
  "claude-ai",
  "claude-code",
  "codex",
  "other",
] as const;
export type AgentClientId = (typeof AGENT_CLIENT_IDS)[number];

export type AgentClientCard = {
  id: AgentClientId;
  name: string;
  /** Where that is, for someone unsure which card is theirs. */
  hint: string;
};

export const agentClients: readonly AgentClientCard[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    hint: "чат на chatgpt.com или в приложении",
  },
  {
    id: "claude-ai",
    name: "Claude.ai",
    hint: "чат на claude.ai или в приложении",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    hint: "агент Anthropic в терминале",
  },
  {
    id: "codex",
    name: "Codex",
    hint: "агент OpenAI в терминале, не сайт ChatGPT",
  },
  { id: "other", name: "Другое", hint: "другой MCP-клиент, скрипт или CI" },
];

/** Something to copy inside a step: the address, a command or a phrase to say. */
export type SetupCopy = {
  value: string;
  /** What the value is, for the button: «Скопировать адрес». */
  label: string;
  copied: string;
  /** A phrase is said to the agent; a command is typed; a URL is pasted into a form. */
  kind: "url" | "command" | "phrase";
  /** Shown before the value: «или выполните сами:». */
  lead?: string;
};

export type SetupStep = {
  text: string;
  copies?: SetupCopy[];
  /** A quieter line under the step. */
  note?: string;
};

export type ClientSetup = {
  id: AgentClientId;
  title: string;
  /** One line that removes the doubt this client raises. */
  intro: string;
  steps: SetupStep[];
  /** After the steps, still quiet. */
  footnote?: string;
};

export const SAVE_PHRASE = "Сохрани это на Полку";

/** The skill Claude Code and Codex install; the server names the same repository (apps/server/connect-guide.ts). */
export const SKILL_INSTALL = "npx skills add artkruglov/polka";
export const SKILL_INDEX_PATH = "/.well-known/agent-skills";

/**
 * The first task after connecting: the agent finds the person's best past
 * work and saves it. Terminal agents look at this machine; web chats search
 * their own history. GET /connect, /llms.txt and the skill carry the same
 * text (apps/server/connect-guide.ts); a test keeps them equal.
 */
export type HarvestClientId = "claude-code" | "codex" | "claude-ai" | "chatgpt";
export const harvestClients: readonly { id: HarvestClientId; name: string }[] =
  [
    { id: "claude-code", name: "Claude Code" },
    { id: "codex", name: "Codex" },
    { id: "claude-ai", name: "Claude.ai" },
    { id: "chatgpt", name: "ChatGPT" },
  ];
const HARVEST_REST =
  "Найди 3–5 самых интересных работ, которые мы делали: исследования, статьи, презентации, дашборды, прототипы. Пропусти личное (здоровье, финансы, переписка) и материалы работодателя или клиентов. Покажи мне список с одной строкой о каждой. После моего «да» сохрани каждую на Полку отдельной работой (polka_publish; HTML или React как есть), с понятным названием, и пришли ссылки.";
export const harvestPrompts = {
  terminal: `Посмотри наши прошлые сессии и файлы проекта на этом компьютере. ${HARVEST_REST}`,
  chat: `Поищи в наших прошлых чатах (поиск по истории/памяти). ${HARVEST_REST}`,
} as const;

export function harvestPrompt(id: HarvestClientId): string {
  return id === "claude-ai" || id === "chatgpt"
    ? harvestPrompts.chat
    : harvestPrompts.terminal;
}

/** The tab for the remembered choice; «Другое» and no choice read like a terminal agent. */
export function harvestClient(id: AgentClientId | null): HarvestClientId {
  return id === "codex" || id === "claude-ai" || id === "chatgpt"
    ? id
    : "claude-code";
}

const url = (value: string): SetupCopy => ({
  value,
  label: "Скопировать адрес",
  copied: "Адрес скопирован",
  kind: "url",
});
const phrase = (value: string): SetupCopy => ({
  value,
  label: "Скопировать фразу",
  copied: "Фраза скопирована",
  kind: "phrase",
});
const command = (value: string, lead = "или выполните сами:"): SetupCopy => ({
  value,
  label: "Скопировать команду",
  copied: "Команда скопирована",
  kind: "command",
  lead,
});

export function clientSetup(origin: string, id: AgentClientId): ClientSetup {
  const mcp = `${origin}/mcp`;
  const say = connectPhrase(origin);
  const allow =
    "Откроется Полка: войдите в этот же аккаунт и нажмите «Разрешить».";
  const ask = `Попросите: «${SAVE_PHRASE}».`;
  switch (id) {
    case "chatgpt":
      return {
        id,
        title: "ChatGPT: добавьте коннектор Полки",
        intro:
          "ChatGPT в браузере не выполняет команды, поэтому коннектор добавляют один раз вручную — это две минуты.",
        steps: [
          {
            text: "Откройте ChatGPT → Settings (Настройки) → Apps & Connectors → Advanced settings и включите Developer mode.",
            note: "Названия пунктов в ChatGPT иногда меняются; ищите «Connectors» и «Developer mode».",
          },
          {
            text: "Нажмите Create (Создать). Name: Полка. В поле MCP Server URL вставьте адрес:",
            copies: [url(mcp)],
          },
          {
            text: `Authentication: OAuth. Сохраните. ${allow}`,
          },
          {
            text: `В чате нажмите «+», включите коннектор «Полка» и попросите: «${SAVE_PHRASE}».`,
            copies: [phrase(SAVE_PHRASE)],
          },
        ],
      };
    case "claude-ai":
      return {
        id,
        title: "Claude.ai: добавьте коннектор Полки",
        intro:
          "Claude.ai в браузере не выполняет команды, поэтому коннектор добавляют один раз вручную — это две минуты.",
        steps: [
          {
            text: "Откройте Claude.ai → Settings (Настройки) → Connectors (Коннекторы) → Add custom connector.",
            note: "Если пункта Connectors нет, на вашем плане коннекторы недоступны или их добавляет администратор организации.",
          },
          {
            text: "Name: Полка. В поле URL вставьте адрес:",
            copies: [url(mcp)],
          },
          {
            text: `Нажмите Add, затем Connect. ${allow}`,
          },
          {
            text: `В чате нажмите «+» → Connectors и включите «Полка». ${ask}`,
            copies: [phrase(SAVE_PHRASE)],
          },
        ],
      };
    case "claude-code":
      return {
        id,
        title: "Claude Code: одной фразой",
        intro:
          "Claude Code работает на вашем компьютере и выполнит команду сам.",
        steps: [
          {
            text: "Скажите Claude Code:",
            copies: [
              phrase(say),
              command(
                `claude mcp add --transport http --scope user polka ${mcp}`,
              ),
            ],
          },
          {
            text: "В Claude Code введите /mcp, выберите polka и нажмите Authenticate.",
          },
          {
            text: `${allow} После этого ${ask.charAt(0).toLowerCase()}${ask.slice(1)}`,
          },
        ],
      };
    case "codex":
      return {
        id,
        title: "Codex: одной фразой",
        intro:
          "Codex — агент OpenAI в терминале, он выполнит команду сам. Если вы пишете в чат на chatgpt.com, выберите ChatGPT.",
        steps: [
          {
            text: "Скажите Codex:",
            copies: [phrase(say), command(`codex mcp add polka --url ${mcp}`)],
          },
          {
            text: `Браузер откроется сам. ${allow}`,
            note: "Если браузер не открылся, выполните: codex mcp login polka.",
          },
          { text: `После этого ${ask.charAt(0).toLowerCase()}${ask.slice(1)}` },
        ],
      };
    case "other":
      return {
        id,
        title: "Другой клиент",
        intro:
          "Любой MCP-клиент со входом через OAuth (Cursor, Gemini CLI, Windsurf и другие) подключается по адресу Полки.",
        steps: [
          {
            text: "Добавьте в клиенте удалённый MCP-сервер (Streamable HTTP) с авторизацией OAuth. Адрес:",
            copies: [url(mcp)],
          },
          {
            text: `${allow} Если у агента есть терминал, можно просто сказать ему:`,
            copies: [phrase(say)],
          },
          {
            text: "Скрипт, CI или программа без входа через браузер: создайте токен в разделе «Для разработчиков» ниже.",
          },
        ],
      };
  }
}

export function parseClientId(
  value: string | null | undefined,
): AgentClientId | null {
  return (AGENT_CLIENT_IDS as readonly string[]).includes(value ?? "")
    ? (value as AgentClientId)
    : null;
}

export const CLIENT_STORAGE_KEY = "polka.agents.client";

/** The remembered choice; browsers without storage (private mode) just forget. */
export function readStoredClient(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): AgentClientId | null {
  try {
    return parseClientId(storage?.getItem(CLIENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeClient(
  id: AgentClientId | null,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
) {
  try {
    if (id) storage?.setItem(CLIENT_STORAGE_KEY, id);
    else storage?.removeItem(CLIENT_STORAGE_KEY);
  } catch {
    // Storage blocked or full: the choice simply is not remembered.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** «только что», «5 минут назад», «вчера», then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "дата неизвестна";
  const diff = now - time;
  if (diff < MINUTE) return "только что";
  if (diff < HOUR) {
    const n = Math.floor(diff / MINUTE);
    return `${n} ${plural(n, "минуту", "минуты", "минут")} назад`;
  }
  if (diff < DAY) {
    const n = Math.floor(diff / HOUR);
    return `${n} ${plural(n, "час", "часа", "часов")} назад`;
  }
  if (diff < 2 * DAY) return "вчера";
  if (diff < 7 * DAY) {
    const n = Math.floor(diff / DAY);
    return `${n} ${plural(n, "день", "дня", "дней")} назад`;
  }
  return new Date(time).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
}

/** A shelf opened less than a day ago: maybe not the one the person meant. */
export function isFreshAccount(
  createdAt: string | null | undefined,
  now = Date.now(),
) {
  if (!createdAt) return false;
  const time = Date.parse(createdAt);
  return Number.isFinite(time) && now - time < DAY;
}

export type SignedInIdentity = {
  provider: string;
  name: string;
  email: string | null;
  linkedAt: string;
  lastUsedAt?: string;
};

/**
 * How this session most likely began. A session lives seven days, so a
 * provider used within that time made it; otherwise the mailbox code or,
 * for an account without a mailbox, the login and password.
 */
export function signInMethod(
  identities: readonly SignedInIdentity[],
  email: string | null,
  now = Date.now(),
): { kind: "provider"; name: string } | { kind: "email" } | { kind: "login" } {
  const recent = identities
    .filter((item) => {
      const used = Date.parse(item.lastUsedAt ?? item.linkedAt);
      return Number.isFinite(used) && now - used < 7 * DAY;
    })
    .sort(
      (a, b) =>
        Date.parse(b.lastUsedAt ?? b.linkedAt) -
        Date.parse(a.lastUsedAt ?? a.linkedAt),
    )[0];
  if (recent) return { kind: "provider", name: recent.name };
  if (email) return { kind: "email" };
  return { kind: "login" };
}

export function signInMethodLabel(
  method: ReturnType<typeof signInMethod>,
): string {
  if (method.kind === "provider") return `через ${method.name}`;
  if (method.kind === "email") return "через почту";
  return "по логину";
}
