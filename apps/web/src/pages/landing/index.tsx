import "./styles.css";
import React, { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  FileUp,
  History,
  Link2,
  LockKeyhole,
} from "lucide-react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { useEditorialList } from "../../entities/editorial/useEditorialList.ts";
import { EditorialCatalog } from "../../widgets/editorial-catalog/index.tsx";
import { Button, LinkButton } from "../../shared/ui/controls.tsx";
import { Wave } from "../../shared/ui/Wave.tsx";

export function Landing() {
  const account = useAccount();
  const [retry, setRetry] = useState(0);
  const catalog = useEditorialList(retry);
  const imports = useCapabilities();
  const canImport = imports.status === "ready" && imports.capabilities.urlImport;
  const livePreview =
    imports.status === "ready" && imports.capabilities.livePreview;
  return (
    <AppShell current="landing" account={account} className="landing">
      <main className="landing-main">
        <section className="landing-hero">
          <span className="eyebrow">Ваши работы. Своя полка.</span>
          <h1>
            Сделали с агентом.
            <br />
            <span>Покажите другим.</span>
          </h1>
          <p>
            Сохраните отчёт, страницу или прототип из чата. Отправьте ссылку —
            получателю не нужен аккаунт в Claude или ChatGPT.
          </p>

          {canImport ? (
            <>
              <form action="/bring" className="landing-entry">
                <Link2 aria-hidden="true" />
                <input
                  type="url"
                  name="url"
                  required
                  aria-label="Ссылка на страницу"
                  placeholder="Вставьте ссылку на публичную HTML-страницу"
                />
                <Button type="submit" variant="primary">
                  Сохранить копию <ArrowUpRight size={18} />
                </Button>
              </form>
              <div className="landing-paths landing-paths--secondary">
                <LinkButton href="/bring#file">
                  <FileUp /> Загрузить файл
                </LinkButton>
                <LinkButton href="/settings/agents">
                  <Bot /> Подключить агента
                </LinkButton>
              </div>
            </>
          ) : (
            <div className="landing-paths" aria-busy={imports.status === "loading"}>
              <LinkButton variant="primary" href="/settings/agents">
                <Bot /> Подключить агента
              </LinkButton>
              <LinkButton href="/bring#file">
                <FileUp /> Загрузить файл
              </LinkButton>
            </div>
          )}

          <small className="landing-fine" role="status">
            {imports.status === "loading"
              ? "Проверяем доступные способы сохранения…"
              : imports.status === "failed"
                ? "Доступность импорта ссылки не удалось проверить. Загрузка файла и подключение агента работают."
                : canImport
                  ? "По ссылке сохраняем самостоятельные публичные HTML-страницы. Для Claude и ChatGPT нужен экспорт файлом или передача файлов агентом."
                  : "Агент сохраняет работы на вашу полку через MCP. Файлом можно сохранить HTML, текст или изображение до 5 МБ."}
            {livePreview &&
              " Поддерживаемые интерактивные страницы открываются в изолированном просмотре."}
          </small>
        </section>

        <div className="landing-wave" aria-hidden="true">
          <Wave />
        </div>

        <section className="landing-steps" aria-label="Как это работает">
          {[
            {
              icon: <FileUp />,
              n: "01",
              title: "Сохраните",
              text: "Агент передаёт работу через MCP, или вы загружаете файл. Копия остаётся на вашей полке, а не в истории чата.",
              href: "/bring#file",
              cta: "Загрузить файл",
            },
            {
              icon: <LockKeyhole />,
              n: "02",
              title: "Поделитесь",
              text: "Доступ по ссылке включается и отзывается за секунду. Получатель видит зафиксированную версию — без аккаунта.",
              href: account ? "/" : `/?login=1&next=${encodeURIComponent("/")}`,
              cta: "Открыть мою полку",
            },
            {
              icon: <History />,
              n: "03",
              title: "Возвращайтесь",
              text: "Новая версия не ломает отправленную ссылку. История сохраняется, к любой версии можно вернуться.",
              href: "/discover",
              cta: "Посмотреть примеры",
            },
          ].map((step) => (
            <article key={step.n}>
              <span className="landing-step-icon">{step.icon}</span>
              <small>{step.n}</small>
              <h2>{step.title}</h2>
              <p>{step.text}</p>
              <a href={step.href}>
                {step.cta} <ArrowRight size={16} />
              </a>
            </article>
          ))}
        </section>

        <section className="landing-catalog">
          <EditorialCatalog
            items={catalog.items.slice(0, 6)}
            loading={catalog.state === "loading"}
            error={catalog.state === "error" ? catalog.error : null}
            onRetry={() => setRetry((value) => value + 1)}
          />
          {catalog.items.length > 6 && (
            <LinkButton href="/discover">
              Все материалы <ArrowUpRight size={18} />
            </LinkButton>
          )}
        </section>

        <section className="landing-company">
          <div>
            <h2>
              Личная полка сегодня.
              <br />
              Общая среда команды — дальше.
            </h2>
            <p>
              Полка — открытый код. Подключайте своего агента через MCP и
              храните работы на своей установке или в облаке. Размещение
              внутри компании требует отдельной настройки.
            </p>
          </div>
          <LinkButton href="/settings/agents">
            Подключить агента <ArrowUpRight size={18} />
          </LinkButton>
        </section>
      </main>
    </AppShell>
  );
}
