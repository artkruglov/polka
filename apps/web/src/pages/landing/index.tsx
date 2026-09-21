import React, { useState } from "react";
import { ArrowUpRight, Bot } from "lucide-react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { useImportCapabilities } from "../../features/import-url/useImportCapabilities.ts";
import { useEditorialList } from "../../entities/editorial/useEditorialList.ts";
import { EditorialCatalog } from "../../widgets/editorial-catalog/index.tsx";
import { Button } from "../../shared/ui/controls.tsx";
export function NewLanding() {
  const account = useAccount();
  const [retry, setRetry] = useState(0);
  const catalog = useEditorialList(retry);
  const imports = useImportCapabilities();
  const canImport = imports.status === "ready" && imports.capabilities.enabled;
  return (
    <AppShell current="landing" account={account} className="p-modern">
      <main className="p-main">
        <section className="p-hero">
          <span className="p-eyebrow">ВАШИ АРТЕФАКТЫ. СВОЯ ПОЛКА.</span>
          <h1>
            Сделали с агентом.
            <br />
            <span>Покажите другим.</span>
          </h1>
          <p>
            Сохраните отчёт, страницу или прототип из чата.
            <br />
            Отправьте ссылку — получателю не нужен аккаунт в Claude или ChatGPT.
          </p>
          <form action="/bring" className="p-entry">
            <input
              type="url"
              name="url"
              required
              aria-label="Ссылка на артефакт"
              placeholder="Вставьте ссылку на артефакт"
            />
            <Button type="submit" variant="primary">
              {canImport ? "Сохранить копию" : "Проверить возможность"}{" "}
              <ArrowUpRight size={18} />
            </Button>
          </form>
          <div className="p-hero-links">
            <a href="/bring#file">Загрузить файл</a>
            <a href="/settings/agents">
              <Bot size={17} /> Настроить агента
            </a>
          </div>
          <small>
            {imports.status === "loading"
              ? "Проверяем доступные способы сохранения…"
              : imports.status === "failed"
                ? "Доступность импорта ссылки не удалось проверить. Можно перейти к загрузке файла."
                : canImport
                  ? "По ссылке сохраняем самостоятельные публичные HTML-страницы. Для Claude и ChatGPT пока нужен экспорт файлом или передача файлов агентом."
                  : "Импорт ссылки на этой установке выключен: форма только проверяет адрес. Сохраните HTML-файл или передайте файлы агентом."}
            {imports.status === "ready" &&
              imports.capabilities.livePreview === true &&
              " Поддерживаемые интерактивные страницы открываются в изолированном просмотре с ограничениями."}
            {imports.status === "ready" &&
              imports.capabilities.livePreview === false &&
              " Интерактивный просмотр на этой установке выключен."}
          </small>
        </section>
        <section className="discover-reference landing-catalog">
          <EditorialCatalog
            items={catalog.items.slice(0, 6)}
            loading={catalog.state === "loading"}
            error={catalog.state === "error" ? catalog.error : null}
            onRetry={() => setRetry((value) => value + 1)}
          />
          <a className="ui-button" href="/discover">
            Все материалы <ArrowUpRight size={18} />
          </a>
          <p className="p-demo-note">
            Редакционные интерактивные примеры. Откройте материал и попробуйте
            его в браузере.
          </p>
        </section>
        <section className="p-benefits">
          {[
            [
              "01",
              "Сохранить важное",
              "Отдельная копия вместо затерянного сообщения в чате.",
              "/bring?url=",
              "Сохранить артефакт",
            ],
            [
              "02",
              "Отправить другу",
              "Доступ по ссылке можно включить и отозвать. Ссылку может открыть любой её получатель.",
              "/bring#file",
              "Попробовать",
            ],
            [
              "03",
              "Найти новое",
              "Открывайте материалы по темам и пробуйте интерактивные примеры.",
              "/discover",
              "Посмотреть примеры",
            ],
          ].map(([n, t, d, h, c]) => (
            <article key={n}>
              <small>{n}</small>
              <h2>{t}</h2>
              <p>{d}</p>
              <a href={h}>{c} ↗</a>
            </article>
          ))}
        </section>
        <section className="p-company">
          <h2>
            Личная полка сегодня.
            <br />
            Общая среда команды — дальше.
          </h2>
          <p>
            Подключайте своего агента через MCP и сохраняйте материалы на своей
            Полке. Размещение в российском облаке и развёртывание внутри
            компании требуют отдельной настройки и проверки. Текущая сборка ещё
            проходит приёмку.
          </p>
          <a href="/connections">Посмотреть подключения и планы ↗</a>
        </section>
      </main>
    </AppShell>
  );
}
