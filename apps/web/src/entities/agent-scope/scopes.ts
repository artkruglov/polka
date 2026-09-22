import type { AgentScope } from "../../../../../packages/contracts/index.ts";

/** One wording of agent permissions for token issue and connector consent. */
export const scopeOptions: Array<{
  id: AgentScope;
  label: string;
  description: string;
  defaultOn: boolean;
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
      "Переименовывать, перемещать, отправлять в корзину и восстанавливать работы.",
    defaultOn: false,
  },
];
