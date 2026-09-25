import "./styles.css";
import React, { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Building2,
  FileUp,
  History,
  LockKeyhole,
  Server,
} from "lucide-react";
import { AppShell, useAccount } from "../../widgets/navigation/index.tsx";
import {
  useCapabilities,
  useSourceUrl,
} from "../../entities/capabilities/useCapabilities.ts";
import { useSourceStars } from "../../entities/capabilities/useSourceStars.ts";
import { useEditorialList } from "../../entities/editorial/useEditorialList.ts";
import { EditorialCatalog } from "../../widgets/editorial-catalog/index.tsx";
import { LinkButton } from "../../shared/ui/controls.tsx";
import { CopyButton } from "../../shared/ui/CopyText.tsx";
import { GitHubMark } from "../../shared/ui/GitHubMark.tsx";
import { Wave } from "../../shared/ui/Wave.tsx";
import { connectPhrase } from "../../entities/onboarding/connect-phrase.ts";
import { SKILL_INDEX_PATH, SKILL_INSTALL } from "../../entities/onboarding/agent-setup.ts";
import {
  SOURCE_LICENSE,
  formatStars,
  onGitHub,
  selfHostGuideUrl,
} from "../../shared/lib/project-links.ts";

/** The hosted guide's first run in four lines (deploy/hosted/README.md has the rest). */
const selfHostCommand = (sourceUrl: string) =>
  [
    `git clone ${sourceUrl} && cd ${sourceUrl.replace(/\/$/, "").split("/").pop()?.replace(/\.git$/, "") || "polka"}`,
    "docker build -t polka:local .",
    "cp deploy/hosted/hosted.env.example deploy/hosted/hosted.env   # домены, пароли, S3, POLKA_IMAGE=polka:local",
    "cd deploy/hosted && docker compose --env-file hosted.env up -d --build",
  ].join("\n");

export function Landing() {
  const account = useAccount();
  // The same phrase the first-run steps show; GET /connect explains the rest to the agent.
  const phrase = connectPhrase(location.origin);
  const [retry, setRetry] = useState(0);
  const catalog = useEditorialList(retry);
  const imports = useCapabilities();
  const livePreview =
    imports.status === "ready" && imports.capabilities.livePreview;
  const sourceUrl = useSourceUrl();
  const github = onGitHub(sourceUrl);
  const stars = formatStars(useSourceStars());
  const guideUrl = selfHostGuideUrl(sourceUrl);
  const command = selfHostCommand(sourceUrl);
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
            Сохраните отчёт, страницу или прототип из любого агента. Отправьте
            ссылку — получателю не нужен аккаунт в Claude или ChatGPT. А
            продолжить работу можно в другом чате или другом агенте.
          </p>

          <div className="landing-agent" role="group" aria-labelledby="landing-agent-title">
            <span id="landing-agent-title" className="landing-agent-title">
              Скопируйте своему агенту
            </span>
            <div className="landing-agent-phrase">
              <code>{phrase}</code>
              <CopyButton
                value={phrase}
                label="Скопировать"
                successText="Скопировано"
                variant="primary"
              />
            </div>
            <small>
              Codex и Claude Code выполнят одну команду сами — Полка откроется в
              браузере, токен не нужен. В Claude (claude.ai и Desktop) и ChatGPT
              коннектор добавляют вручную: настройки → коннекторы → адрес{" "}
              <code>{`${location.origin}/mcp`}</code>. Пошагово:{" "}
              <a href="/settings/agents?client=claude-ai">Claude</a> ·{" "}
              <a href="/settings/agents?client=claude-code">Claude Code</a> ·{" "}
              <a href="/settings/agents?client=codex">Codex</a> ·{" "}
              <a href="/settings/agents?client=chatgpt">ChatGPT</a>.
            </small>
            <small className="landing-agent-skill">
              Claude Code и Codex ставят плагин Полки — подключение и скилл
              сразу. Для других агентов скилл отдельно: <code>{SKILL_INSTALL}</code>{" "}
              <CopyButton value={SKILL_INSTALL} variant="quiet" label="Скопировать" successText="Скопировано" />
              <a href={SKILL_INDEX_PATH}>Адрес скилла для агента</a>
            </small>
          </div>

          <div className="landing-paths">
            <LinkButton variant="primary" href="/settings/agents">
              <Bot /> Подключить агента
            </LinkButton>
            <LinkButton href={guideUrl} target="_blank" rel="noopener noreferrer">
              <Server /> Развернуть у себя
            </LinkButton>
          </div>
          <a
            className="landing-oss"
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {github && <GitHubMark size={16} />}
            {github && !stars
              ? `Открытый код на GitHub · ${SOURCE_LICENSE}`
              : `Открытый код · ${SOURCE_LICENSE}`}
            {stars && <span className="landing-oss-stars">· ★ {stars} на GitHub</span>}
          </a>

          <nav className="landing-more" aria-label="Другие пути">
            <a href="/bring#file">
              <FileUp aria-hidden="true" /> Загрузить файл
            </a>
            <a href="/enterprise">
              <Building2 aria-hidden="true" /> Для компаний
            </a>
          </nav>

          <small className="landing-fine">
            Агент сохраняет работы на вашу полку через MCP. Файлом можно
            сохранить HTML, текст или изображение до 5 МБ.
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
              title: "Продолжайте",
              text: "Любой ваш агент найдёт работу на полке — по названию или по словам из текста, прочитает исходник и сохранит новую версию. Отправленная ссылка при этом не меняется.",
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

        <section className="landing-selfhost" aria-labelledby="landing-selfhost-title">
          <div className="landing-selfhost-intro">
            <span className="eyebrow">Открытый код · {SOURCE_LICENSE}</span>
            <h2 id="landing-selfhost-title">Полка для вашей компании</h2>
            <p>
              Сотрудники работают в разных агентах, а результаты сохраняются
              на Полке на ваших серверах: один Docker-образ, PostgreSQL и ваше
              S3-хранилище с версионированием. Данные не покидают вашу сеть.
              Для закрытых доработок есть коммерческая лицензия.
            </p>
          </div>
          <ol className="landing-selfhost-steps">
            <li>
              <strong>Docker, PostgreSQL, S3</strong>
              <span>
                Виртуальная машина с Docker, домен и S3-бакет с версионированием.
                PostgreSQL поднимается вместе с приложением.
              </span>
            </li>
            <li>
              <strong>docker compose up</strong>
              <span>
                Клонируйте репозиторий, заполните hosted.env и запустите. TLS
                выдаёт встроенный Caddy.
              </span>
            </li>
            <li>
              <strong>Подключите агентов сотрудников</strong>
              <span>
                Каждый копирует фразу своему агенту. Вход — по рабочей почте или
                через OpenID Connect компании.
              </span>
            </li>
          </ol>
          <div className="landing-selfhost-command">
            <pre>
              <code>{command}</code>
            </pre>
            <CopyButton value={command} label="Скопировать" successText="Скопировано" />
          </div>
          <div className="landing-selfhost-actions">
            <LinkButton
              variant="primary"
              href={guideUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {github ? <GitHubMark /> : <Server />}
              {github ? "Инструкция на GitHub" : "Инструкция"}
            </LinkButton>
            <LinkButton href="/enterprise?interest=self-hosted#request">
              Нужна помощь <ArrowUpRight size={18} />
            </LinkButton>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
