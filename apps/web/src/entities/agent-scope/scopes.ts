import type { AgentScope } from "../../../../../packages/contracts/index.ts";

/** One wording of agent permissions for token issue and connector consent. */
export const scopeOptions: Array<{
  id: AgentScope;
  label: string;
  description: string;
  defaultOn: boolean;
  /** Only for chat connectors (OAuth), never for a pasted token. */
  oauthOnly?: boolean;
}> = [
  {
    id: "context",
    label: "Сведения и статус",
    description:
      "Сведения о подключении, лимиты и статус собственных сохранений.",
    defaultOn: true,
  },
  {
    id: "capture",
    label: "Сохранять новые работы",
    description:
      "Сохранять файлы через MCP и импортировать поддерживаемые ссылки, если импорт включён.",
    defaultOn: true,
  },
  {
    id: "read",
    label: "Читать список",
    description: "Показывать агенту список сохранённых работ.",
    defaultOn: false,
  },
  {
    id: "source:read",
    label: "Читать исходники и шаблоны",
    description:
      "Получать содержимое выбранных версий всей вашей полки. Это отдельное право, шире чтения списка.",
    defaultOn: false,
  },
  {
    id: "revise",
    label: "Создавать версии",
    description: "Добавлять версии существующих работ.",
    defaultOn: false,
  },
  {
    id: "share",
    label: "Управлять ссылками",
    description: "Выдавать и отзывать ссылки для всей вашей полки.",
    defaultOn: false,
  },
  {
    id: "manage",
    label: "Управлять названиями, папками и корзиной",
    description:
      "Переименовывать работы и раскладывать их по папкам, создавать, переименовывать и удалять пустые папки, отправлять работы в корзину и восстанавливать.",
    defaultOn: false,
  },
  {
    id: "sign_in",
    label: "Давать ссылку для входа",
    description:
      "По просьбе «Открой мою Полку» агент даёт одноразовую ссылку, которая открывает временную полку в браузере. Закреплённую полку агент не открывает: он подсказывает, как войти.",
    defaultOn: false,
    oauthOnly: true,
  },
];
