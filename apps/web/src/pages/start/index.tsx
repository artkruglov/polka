import "./styles.css";
import React from "react";
import { ArrowUpRight, Bot, Link2, FileUp } from "lucide-react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
export function FirstSave() {
  const account = useAccount();
  const imports = useCapabilities();
  const canImport = imports.status === "ready" && imports.capabilities.urlImport;
  return (
    <AppShell current="bring" account={account}>
      <main className="start-main">
        <header className="start-heading">
          <span className="eyebrow">Начните с одной работы</span>
          <h1>
            Хорошим идеям
            <br />
            есть где остаться.
          </h1>
          <p>
            Перенесите результат из чата на свою полку. Открывайте снова,
            обновляйте и делитесь ссылкой.
          </p>
        </header>
        <div className="start-options">
          <a className="start-file-option" href="/bring#file">
            <span className="start-option-icon">
              <FileUp />
            </span>
            <h2>Загрузить файл</h2>
            <p>
              HTML, текст или изображение с компьютера. Выберите файл и
              сохраните его на полку.
            </p>
            <span className="start-option-action">
              Выбрать файл <ArrowUpRight />
            </span>
          </a>
          <a href="/settings/agents">
            <span className="start-option-icon">
              <Bot />
            </span>
            <h2>Подключить агента</h2>
            <p>
              Настройте Claude, Codex или другой MCP-клиент, чтобы сохранять
              выбранные работы из чата.
            </p>
            <span className="start-option-action">
              Настроить подключение <ArrowUpRight />
            </span>
          </a>
        </div>
        {canImport ? (
          <a className="start-link-demo" href="/bring?url=">
            <Link2 />
            <div>
              <strong>Есть ссылка на работу?</strong>
              <p>
                Сохраните копию поддерживаемой HTML-страницы и откройте её на
                своей полке.
              </p>
            </div>
            <ArrowUpRight />
          </a>
        ) : (
          <p className="start-link-note" role="status">
            {imports.status === "ready"
              ? "Импорт по ссылке на этой Полке выключен: артефакты Claude и ChatGPT сохраняйте файлом или через агента."
              : imports.status === "failed"
                ? "Доступность импорта по ссылке проверить не удалось; загрузка файла и агент работают."
                : "Проверяем, доступен ли импорт по ссылке…"}
          </p>
        )}
        <a className="onboard-legacy" href="/discover">
          Посмотреть примеры работ <ArrowUpRight />
        </a>
      </main>
    </AppShell>
  );
}
