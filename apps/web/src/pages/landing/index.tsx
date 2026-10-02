import "./styles.css";
import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  Building2,
  Database,
  FileUp,
  FolderTree,
  History,
  Link2,
  LockKeyhole,
  Plus,
  Search,
  Server,
  ShieldCheck,
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
import { LandingHeader } from "./LandingHeader.tsx";
import { LandingStage } from "./LandingStage.tsx";
import { ConnectAgent } from "../../widgets/connect-agent/index.tsx";
import { ConnectGuide } from "../../widgets/agent-setup/index.tsx";
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
  const [retry, setRetry] = useState(0);
  const catalog = useEditorialList(retry);
  const imports = useCapabilities();
  const livePreview = imports.status === "ready" && imports.capabilities.livePreview;
  const sourceUrl = useSourceUrl();
  const github = onGitHub(sourceUrl);
  const stars = formatStars(useSourceStars());
  const guideUrl = selfHostGuideUrl(sourceUrl);
  const command = selfHostCommand(sourceUrl);
  useEffect(() => {
    if (location.hash === "#connect") document.getElementById("connect")?.scrollIntoView();
  }, []);
  return (
    <AppShell current="landing" account={account} className="landing" bare>
      <LandingHeader signedIn={!!account} sourceUrl={sourceUrl} onGitHub={github} stars={stars} />
      <main className="lp-main">
        <section className="lp-hero">
          <div className="lp-hero-glow" aria-hidden="true" />
          <div className="lp-hero-copy">
            <span className="lp-pill">
              <i aria-hidden="true" /> Рабочее место для ваших агентов
            </span>
            <h1>
              Сделали с агентом.
              <br />
              <span>Покажите другим.</span>
            </h1>
            <p>
              Агент кладёт сюда страницы, отчёты и целые папки проектов, в следующем чате берёт их,
              правит отдельные файлы и сохраняет версию. Другой чат или другой агент продолжает с
              того же места. Вам — ссылка без аккаунта в Claude или ChatGPT.
            </p>
            <ConnectAgent className="lp-connect-card" />
            <div className="lp-cta">
              <a className="lp-button lp-button--primary lp-button--lg" href="#connect">
                <Bot aria-hidden="true" /> Подключить агента
              </a>
              <a className="lp-button lp-button--ghost lp-button--lg" href={guideUrl} target="_blank" rel="noopener noreferrer">
                <Server aria-hidden="true" /> Развернуть у себя
              </a>
              <a className="lp-textlink" href="/bring#file">
                <FileUp aria-hidden="true" size={18} /> или загрузить файл
              </a>
            </div>
            <small className="lp-fine">
              Папка страниц — одним проектом до 400 файлов; файлом можно сохранить HTML, текст или
              изображение до 5 МБ.
              {livePreview && " Поддерживаемые интерактивные страницы открываются в изолированном просмотре."}
            </small>
          </div>
          <LandingStage />
        </section>

        <ul className="lp-trust" aria-label="Почему Полке можно доверить работы">
          <li>
            <ShieldCheck aria-hidden="true" /> <span><b>Песочница</b> страницы открываются на отдельном домене без сети</span>
          </li>
          <li>
            <Database aria-hidden="true" /> <span><b>Данные в России</b> Yandex Cloud, без обучения моделей</span>
          </li>
          <li>
            <GitHubMark size={20} /> <span><b>Открытый код</b> {SOURCE_LICENSE}, можно поставить у себя</span>
          </li>
          <li>
            <BadgeCheck aria-hidden="true" /> <span><b>Бесплатно</b> на время пилота, без карты</span>
          </li>
        </ul>

        <section id="how" className="lp-section" aria-labelledby="lp-how-title">
          <header className="lp-section-head">
            <span className="lp-kicker">Как это работает</span>
            <h2 id="lp-how-title">Три шага, и работа живёт дальше чата</h2>
          </header>
          <ol className="lp-steps">
            {[
              {
                icon: <FileUp />,
                title: "Сохраните",
                text: "Агент передаёт работу через MCP, или вы загружаете файл. Копия остаётся на вашей полке, а не в истории чата.",
                href: "/bring#file",
                cta: "Загрузить файл",
              },
              {
                icon: <LockKeyhole />,
                title: "Поделитесь",
                text: "Доступ по ссылке включается и отзывается за секунду. Получатель видит зафиксированную версию — без аккаунта.",
                href: account ? "/" : `/?login=1&next=${encodeURIComponent("/")}`,
                cta: "Открыть мою полку",
              },
              {
                icon: <History />,
                title: "Продолжайте",
                text: "Любой ваш агент найдёт работу — по названию или по словам из текста, прочитает файлы и сохранит новую версию. Отправленная ссылка при этом не меняется.",
                href: "/discover",
                cta: "Посмотреть примеры",
              },
            ].map((step, index) => (
              <li key={step.title}>
                <span className="lp-step-n">{String(index + 1).padStart(2, "0")}</span>
                <span className="lp-icon">{step.icon}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
                <a href={step.href}>
                  {step.cta} <ArrowRight size={16} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ol>
        </section>

        <section id="can" className="lp-section" aria-labelledby="lp-can-title">
          <header className="lp-section-head">
            <span className="lp-kicker">Что умеет Полка</span>
            <h2 id="lp-can-title">Папка с версиями, а не ещё один диск</h2>
          </header>
          <div className="lp-bento">
            <article className="lp-card lp-card--wide">
              <span className="lp-icon"><FolderTree /></span>
              <h3>Папка, которую правит агент</h3>
              <p>
                Исследование, документация, набор экранов — одна работа-папка. Агент перечисляет
                файлы, читает нужный, добавляет и удаляет файлы по MCP, без выхода в сеть.
                Получатель видит дерево страниц.
              </p>
              <pre className="lp-code" aria-hidden="true">{`polka_list_files        → 5 файлов
polka_read_file         docs/report.md
polka_change_files      put docs/risks.md
                        remove draft.md   → v3`}</pre>
            </article>
            <article className="lp-card">
              <span className="lp-icon"><Search /></span>
              <h3>Поиск по тексту</h3>
              <p>Работу находят по словам внутри, а не только по названию: вы на полке, ваш агент — в другом чате.</p>
              <div className="lp-snippet" aria-hidden="true">
                <span>…рынок <mark>агентных</mark> инструментов растёт…</span>
              </div>
            </article>
            <article className="lp-card">
              <span className="lp-icon"><History /></span>
              <h3>Версии и честные ссылки</h3>
              <p>Каждая версия неизменна и остаётся в истории. Ссылку можно закрыть в один клик.</p>
            </article>
            <article className="lp-card">
              <span className="lp-icon"><Bot /></span>
              <h3>Один диск для любого агента</h3>
              <p>Начатое в одном чате продолжает другой чат или другой агент: ищет работу, спрашивает, что изменилось, читает заметку полки.</p>
            </article>
            <article className="lp-card">
              <span className="lp-icon"><BadgeCheck /></span>
              <h3>Принятая версия</h3>
              <p>Отметьте версию, которая настоящая, и кто за неё отвечает. Новая версия отметку не снимает.</p>
            </article>
            <article className="lp-card lp-card--accent">
              <span className="lp-icon"><Users /></span>
              <h3>Полки отделов</h3>
              <p>На своей установке компании: общая полка отдела с ролями, работы остаются у отдела.</p>
              <a href="/enterprise">
                Для компаний <ArrowRight size={16} aria-hidden="true" />
              </a>
            </article>
          </div>
        </section>

        <section id="connect" className="lp-section lp-connect" aria-labelledby="landing-connect-title">
          <header className="lp-section-head">
            <span className="lp-kicker">Подключение</span>
            <h2 id="landing-connect-title">Минута и один раз</h2>
            <p>Выберите, где вы работаете с ИИ, — дальше агент сохраняет работы сам, а вы просите «Сохрани это на Полку».</p>
          </header>
          <div className="lp-card lp-card--flat">
            <ConnectGuide />
          </div>
        </section>

        <section className="lp-section lp-catalog" aria-label="Лента">
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

        <section className="lp-section lp-faq" aria-labelledby="landing-faq-title">
          <header className="lp-section-head">
            <span className="lp-kicker">Вопросы</span>
            <h2 id="landing-faq-title">Коротко о главном</h2>
          </header>
          <div className="lp-faq-list">
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
              q: "Чем это отличается от обычного диска?",
              a: "Это не файловая система: каждое сохранение — неизменная версия, а не перезапись на месте, и папку не нужно монтировать или синхронизировать. Зато у работы есть ссылка для людей, история версий и поиск; агент работает с ней по MCP, из терминала или по HTTP.",
            },
            {
              q: "Что значит «принятая версия»?",
              a: "Отметка, которую ставите вы (на полке отдела — куратор): какая версия работы настоящая. Её видите вы и подключённые агенты, на полке отдела ещё и коллеги; получатель ссылки её не видит. Сама отметка ссылки не двигает, а новая версия отметку не снимает.",
            },
            {
              q: "Что делает агент, когда читает мою полку?",
              a: "Ищет работы по словам внутри, спрашивает, что изменилось с прошлого раза, и читает вашу заметку «как у нас принято». Читать он может только то, что вы ему разрешили при подключении.",
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
              <summary>
                {item.q} <Plus aria-hidden="true" size={20} />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
          </div>
        </section>

        <section className="lp-selfhost" aria-labelledby="lp-selfhost-title">
          <div className="lp-selfhost-intro">
            <span className="eyebrow">Открытый код · {SOURCE_LICENSE}</span>
            <h2 id="lp-selfhost-title">Полка для вашей компании</h2>
            <p>
              Сотрудники работают в разных агентах, а результаты сохраняются
              на Полке на ваших серверах: один Docker-образ, PostgreSQL и ваше
              S3-хранилище с версионированием. Данные не покидают вашу сеть.
              Открытое ядро бесплатно. Для организаций есть коммерческая
              редакция: ссылки только для сотрудников, агент только к нужной
              папке, журнал действий агентов для службы безопасности.
            </p>
          </div>
          <ol className="lp-selfhost-steps">
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
          <div className="lp-selfhost-command">
            <pre>
              <code>{command}</code>
            </pre>
            <CopyButton value={command} label="Скопировать" successText="Скопировано" />
          </div>
          <div className="lp-selfhost-actions">
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
      <footer className="lp-footer">
        <a className="brand" href="/" aria-label="Полка — главная">полка</a>
        <nav aria-label="Документы">
          <a href="/privacy">Политика</a>
          <a href="/terms">Соглашение</a>
          <a href="/enterprise">Для компаний</a>
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
            {github ? "Открытый код на GitHub" : "Открытый код"}
          </a>
        </nav>
      </footer>
    </AppShell>
  );
}
