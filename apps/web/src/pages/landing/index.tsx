import "./styles.css";
import React, { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Building2,
  FileUp,
  FolderTree,
  History,
  LockKeyhole,
  Search,
  Server,
  Users,
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
import { ConnectAgent } from "../../widgets/connect-agent/index.tsx";
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
            Сохраните отчёт, страницу, прототип или целую папку связанных
            страниц из любого агента. Отправьте ссылку — получателю не нужен
            аккаунт в Claude или ChatGPT. А продолжить работу можно в другом
            чате или другом агенте.
          </p>

          <ConnectAgent className="landing-agent" />

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
            Агент сохраняет работы на вашу полку через MCP, а папку страниц —
            одним проектом до 400 файлов. Файлом можно сохранить HTML, текст
            или изображение до 5 МБ.
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

        <section className="landing-features" aria-labelledby="landing-features-title">
          <h2 id="landing-features-title">Что умеет Полка</h2>
          <div className="landing-features-grid">
            {[
              {
                icon: <FolderTree />,
                title: "Проект из папки",
                text: "Исследование, документация, набор экранов — агент сохраняет всю папку одной работой. Получатель видит дерево страниц, ссылки между ними работают.",
              },
              {
                icon: <Search />,
                title: "Поиск по тексту",
                text: "Работу находят по словам внутри, а не только по названию: вы на полке, ваш агент — когда продолжает её в другом чате.",
              },
              {
                icon: <History />,
                title: "Версии и честные ссылки",
                text: "Каждая версия неизменна. Ссылка показывает ровно ту версию, которой вы поделились, и закрывается в один клик.",
              },
              {
                icon: <Users />,
                title: "Полки отделов",
                text: "На своей установке компании: общая полка отдела с ролями, агенты сотрудников сохраняют туда, работы остаются у отдела.",
                href: "/enterprise",
              },
            ].map((item) => (
              <article key={item.title}>
                <span className="landing-step-icon">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
                {item.href && (
                  <a href={item.href}>
                    Для компаний <ArrowRight size={16} />
                  </a>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="landing-trust" aria-label="Почему Полке можно доверить работы">
          <ul>
            <li>
              <strong>Бесплатно</strong>
              <span>на время пилота, без карты</span>
            </li>
            <li>
              <strong>Данные в России</strong>
              <span>Yandex Cloud; работы не идут на обучение моделей</span>
            </li>
            <li>
              <strong>Открытый код</strong>
              <span>{SOURCE_LICENSE}, можно поставить у себя</span>
            </li>
            <li>
              <strong>Песочница</strong>
              <span>страницы открываются на отдельном домене без сети</span>
            </li>
          </ul>
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

        <section className="landing-faq" aria-labelledby="landing-faq-title">
          <h2 id="landing-faq-title">Коротко о главном</h2>
          {[
            {
              q: "Что увидит получатель ссылки?",
              a: "Работу целиком — страницу, документ, интерактивный прототип или проект с деревом страниц. Без регистрации и без аккаунта в Claude или ChatGPT. Ровно ту версию, которой вы поделились.",
            },
            {
              q: "Какие агенты подходят?",
              a: "Claude и ChatGPT — через коннектор, Claude Code и Codex — одной командой, скрипты — через HTTP API. Скажите агенту «Подключи Полку» и следуйте его подсказкам.",
            },
            {
              q: "Кто видит мои работы?",
              a: "Только вы, пока вы не включите ссылку. Ссылку можно ограничить сроком 1, 7 или 30 дней и закрыть в любой момент.",
            },
            {
              q: "Сколько это стоит?",
              a: "Облако polochka.app бесплатно на время пилота. Своя установка по открытой лицензии тоже бесплатна. Для организаций есть коммерческая редакция по договору.",
            },
          ].map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </section>

        <section className="landing-selfhost" aria-labelledby="landing-selfhost-title">
          <div className="landing-selfhost-intro">
            <span className="eyebrow">Открытый код · {SOURCE_LICENSE}</span>
            <h2 id="landing-selfhost-title">Полка для вашей компании</h2>
            <p>
              Сотрудники работают в разных агентах, а результаты сохраняются
              на Полке на ваших серверах: один Docker-образ, PostgreSQL и ваше
              S3-хранилище с версионированием. Данные не покидают вашу сеть.
              Открытое ядро бесплатно. Для организаций есть коммерческая
              редакция: ссылки только для сотрудников, агент только к нужной
              папке, журнал действий агентов для службы безопасности.
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
              <strong>Подключите агентов и отделы</strong>
              <span>
                Каждый копирует фразу своему агенту. Вход — по рабочей почте или
                через OpenID Connect компании. Администратор заводит полки
                отделов и участников с ролями.
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
            <LinkButton href="/enterprise">
              Коммерческая редакция <ArrowUpRight size={18} />
            </LinkButton>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
