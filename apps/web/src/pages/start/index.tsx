import React, { useEffect, useState, useRef } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Mail,
  Bot,
  Link2,
  FileUp,
} from "lucide-react";
import { request } from "../../shared/api/client.ts";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { safeNext } from "../../shared/lib/safe-next.ts";
import { Button, TextField, Notice } from "../../shared/ui/controls.tsx";
import { useImportCapabilities } from "../../features/import-url/useImportCapabilities.ts";
export function FirstSave() {
  const account = useAccount();
  const imports = useImportCapabilities();
  const canImport = imports.status === "ready" && imports.capabilities.enabled;
  return (
    <AppShell
      current="bring"
      account={account}
      className="p-modern entry-redesign start-redesign"
    >
      <main className="p-main">
        <header className="entry-heading">
          <span className="entry-eyebrow">НАЧНИТЕ С ОДНОЙ РАБОТЫ</span>
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
        <a className="start-link-demo" href="/bring?url=">
          <Link2 />
          <div>
            <strong>
              Есть ссылка на работу?{" "}
              {!canImport && imports.status === "ready" && (
                <span className="entry-demo-label">Импорт выключен</span>
              )}
            </strong>
            <p>
              {canImport
                ? "Сохраните копию поддерживаемой HTML-страницы и откройте её на Полке."
                : imports.status === "ready"
                  ? "На этой установке можно проверить адрес или сохранить материал файлом."
                  : "Откройте форму, чтобы проверить доступность импорта."}
            </p>
          </div>
          <ArrowUpRight />
        </a>
        <a className="onboard-legacy" href="/discover">
          Посмотреть примеры работ <ArrowUpRight />
        </a>
      </main>
    </AppShell>
  );
}
