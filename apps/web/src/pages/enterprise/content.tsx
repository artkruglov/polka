import React, { useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Cloud,
  CodeXml,
  Handshake,
  KeyRound,
  LibraryBig,
  Plug,
  Server,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { EnterpriseInterest } from "../../../../../packages/contracts/constants.ts";
import { Badge, LinkButton } from "../../shared/ui/controls.tsx";
import { SOURCE_LICENSE, SOURCE_URL } from "../../shared/lib/project-links.ts";
import { CONTACT, EnterpriseForm, initialInterest } from "./form.tsx";

/** Something that is not on main yet: said plainly, never promised. */
const InProgress = () => <Badge tone="warning">в разработке</Badge>;

const VALUES: Array<{
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  points: React.ReactNode[];
}> = [
  {
    icon: <ShieldCheck />,
    title: "Данные под вашим контролем",
    points: [
      "Своя установка — на ваших серверах или в российском облаке.",
      "Работы и все их версии лежат в вашем S3-совместимом хранилище с версионированием, например MinIO или Yandex Object Storage; база — PostgreSQL рядом.",
      "На polochka.app данные хранятся в России, в Yandex Cloud.",
      "Интерактивные страницы открываются на отдельном домене просмотра, в песочнице без сети и без cookie Полки.",
      "Ссылки на 1, 7 или 30 дней, отзываются в любой момент.",
      "Каждая версия неизменна и имеет контрольную сумму SHA-256: по ссылке открывается ровно та версия, которой поделились.",
    ],
  },
  {
    icon: <Users />,
    title: "Полки отделов",
    points: [
      "Общая полка отдела с ролями: читатель, автор, куратор, администратор. Работы видят все участники и находят поиском по тексту.",
      "Работы принадлежат отделу, а не сотруднику: он уходит — работы остаются.",
      "Агент подключается к выбранной полке — своей или отдела; роль проверяется на каждом действии, читатель только читает.",
      "Администратор компании видит все полки отделов и одним действием убирает ушедшего сотрудника со всех полок вместе с его агентами.",
      "Ссылки наружу с полки отдела выпускают куратор и администратор; за ссылку отвечает тот, кто её выпустил.",
      "Получатели комментируют работу по ссылке; обсуждение видят все участники полки, отвечают и закрывают треды кураторы и администраторы.",
    ],
  },
  {
    icon: <LibraryBig />,
    title: "Библиотеки шаблонов команды",
    points: [
      "Утверждённые шаблоны отчётов, презентаций и страниц с закреплёнными версиями.",
      "Роли участников, приглашения и журнал действий.",
      "Агент сотрудника читает шаблон нужной версии и делает по нему новую работу.",
    ],
  },
  {
    icon: <Bot />,
    title: "Агенты сохраняют сами",
    points: [
      "Claude.ai и ChatGPT — коннектор MCP с входом через OAuth.",
      "Claude Code и Codex — одна команда, без токена.",
      <>
        Скрипты и внутренние агенты — HTTP API <code>POST /api/v1/publish</code>
        .
      </>,
      <>
        Справка для агентов — <code>/llms.txt</code> и{" "}
        <code>/openapi.json</code>.
      </>,
      "Папку со связанными страницами — README, документы, экраны со своими стилями, картинки — агент сохраняет одним проектом: до 400 файлов, дерево страниц и рабочие ссылки между ними.",
      "У каждого сотрудника свой аккаунт и своё подключение с выбранными правами.",
      "Работу можно продолжить в другом чате или другом агенте: агент находит её на полке по названию или по словам из текста, читает исходник и сохраняет новую версию.",
    ],
  },
  {
    icon: <ShieldAlert />,
    title: "Модерация и защита от злоупотреблений",
    points: [
      "Получатель ссылки может пожаловаться на страницу.",
      "При сохранении Полка ищет признаки фишинга: просьбы продиктовать код, перевести деньги или войти на сайте, похожем на сайт банка. Экран входа в прототипе ссылку не задерживает: введённое на Полке никуда не уходит.",
      "Ссылки новых аккаунтов и подозрительные страницы ждут проверки, после нескольких жалоб ссылка встаёт на паузу.",
      "Оператор получает письмо и решает в один клик.",
      <>
        Автоматическая проверка содержимого по правилам <InProgress />
      </>,
    ],
  },
  {
    icon: <CodeXml />,
    title: "Открытый код и коммерческая лицензия",
    points: [
      `Код открыт под ${SOURCE_LICENSE}: его можно проверить, поставить у себя и дорабатывать.`,
      "Коммерческая редакция для организаций — расширение ядра по договору и с ключом лицензии (см. ниже).",
      "Коммерческая лицензия на само ядро — если не хотите публиковать свои изменения или встраиваете Полку в закрытый продукт.",
      "Гарантии, поддержка и SLA — по договору.",
    ],
  },
  {
    icon: <KeyRound />,
    title: "Вход через SSO и доступ по домену",
    points: [
      "Своя установка подключает IdP компании по OpenID Connect (Keycloak, Avanpost, ADFS и другие): кнопка входа, разрешённые домены, группа из claim.",
      "Компании на Яндекс 360 входят через Яндекс ID аккаунтами организации; есть и вход через VK ID.",
      "Доступ по домену: сотрудник с подтверждённой почтой компании при первом входе становится читателем или куратором вашей библиотеки шаблонов. Настраивает администратор установки; исключённого участника домен не вернёт.",
      "SAML и SCIM пока не поддерживаются — напишите в заявке, если они нужны.",
    ],
  },
];

/**
 * The commercial edition for organisations (docs/specs/EXTENSIONS.md): an
 * extension of the open core under an agreement and a license key. What is
 * ready says so; the rest is in progress, in the roadmap's order.
 */
const NEXT: Array<{
  icon: React.ReactNode;
  title: string;
  ready: boolean;
  points: string[];
}> = [
  {
    icon: <ShieldCheck />,
    title: "Контроль ссылок",
    ready: true,
    points: [
      "Ссылки только для сотрудников: открываются после входа в Полку компании.",
      "Предельный срок ссылок для всей компании.",
      "Кто выпускает ссылки с полок отделов: кураторы или только администраторы.",
    ],
  },
  {
    icon: <Bot />,
    title: "Журнал агентов",
    ready: true,
    points: [
      "Что сохранял, менял, переносил и кому открывал ссылки агент каждого сотрудника — на всех полках.",
      "Отбор по сроку и сотруднику, выгрузка в SIEM (JSON Lines).",
    ],
  },
  {
    icon: <Plug />,
    title: "Встраивание в ваши системы",
    ready: false,
    points: [
      "События о новых версиях и ссылках — для Битрикс24, Jira, 1С и рабочих чатов.",
      "Выгрузка утверждённых версий в сетевые папки и диски: HTML, PDF-снимок и манифест с SHA-256.",
      "Встраивание интерактивных работ в вики и корпоративный портал.",
    ],
  },
  {
    icon: <Server />,
    title: "Корпоративный вход и эксплуатация",
    ready: false,
    points: [
      "SAML и SCIM, синхронизация групп из IdP в участников полок отделов.",
      "Агент только к нужной папке или библиотеке.",
      "Установка без доступа в интернет, алерты в вашу систему мониторинга.",
      "Отказоустойчивая конфигурация и восстановление по регламенту с RPO и RTO.",
    ],
  },
];

/** How Полка works in a company today, in three steps. */
const HOW: Array<{ icon: React.ReactNode; title: string; text: string }> = [
  {
    icon: <Server />,
    title: "Установите и подключите вход",
    text: "Docker-образ, PostgreSQL и ваше S3-хранилище. Сотрудники входят через IdP компании по OpenID Connect или через Яндекс ID.",
  },
  {
    icon: <Bot />,
    title: "Сотрудники подключают агентов",
    text: "Каждый говорит своему агенту одну фразу — ChatGPT, Claude, Codex или Claude Code. Права выбирает сам; все подключения видны и отзываются.",
  },
  {
    icon: <LibraryBig />,
    title: "Работы — на полках, шаблоны — в библиотеке",
    text: "Агент сохраняет результат на полку сотрудника или на общую полку отдела: с версиями и поиском по тексту. Утверждённые шаблоны лежат в общей библиотеке команды, наружу работа уходит по отзываемой ссылке.",
  },
];

const FAQ: Array<{ q: string; a: React.ReactNode }> = [
  {
    q: "Где хранятся данные?",
    a: (
      <>
        На polochka.app — в России, в Yandex Cloud: база, файлы и резервные
        копии. Подробно — в <a href="/privacy">Политике обработки данных</a>. На
        своей установке данные лежат там, где вы её развернули: Полка сама
        никуда их не отправляет.
      </>
    ),
  },
  {
    q: "Можно поставить Полку у себя?",
    a: (
      <>
        Да. Нужны Docker, PostgreSQL и S3-совместимое хранилище с
        версионированием. Есть{" "}
        <a
          href={`${SOURCE_URL}/blob/main/deploy/hosted/README.md`}
          target="_blank"
          rel="noopener noreferrer"
        >
          инструкция для одной виртуальной машины
        </a>
        . Это не отказоустойчивая конфигурация: если она нужна, обсудим в
        заявке.
      </>
    ),
  },
  {
    q: "Что с лицензией?",
    a: (
      <>
        Код открыт под {SOURCE_LICENSE}. Лицензия не нужна, если вы запускаете
        Полку без изменений или публикуете свои изменения на тех же условиях.
        Коммерческая лицензия нужна, чтобы не публиковать изменения в установке,
        которой пользуются другие, или встроить Полку в закрытый продукт.
        Коммерческая редакция для организаций — отдельное расширение ядра по
        договору, оно включается ключом лицензии; само ядро ключа не требует.{" "}
        <a
          href={`${SOURCE_URL}/blob/main/COMMERCIAL.md`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Условия
        </a>
        .
      </>
    ),
  },
  {
    q: "Как Полка работает с нашими системами?",
    a: "Сейчас — через ваше S3-хранилище, вход по OpenID Connect, MCP для агентов и HTTP API для скриптов и внутренних ботов. События для ваших систем и выгрузка в сетевые папки и диски — в разработке: напишите в заявке, какие системы у вас, и мы начнём с них.",
  },
  {
    q: "Видят ли коллеги работы друг друга?",
    a: "На общей полке отдела — да: работы видят все её участники, а что может каждый, решает роль. Личная полка сотрудника видна только ему, пока он не поделится ссылкой или не опубликует работу в библиотеке шаблонов команды. Полки отделов включает администратор установки.",
  },
  {
    q: "Используете ли вы наши работы для обучения ИИ?",
    a: "Нет. Оператор polochka.app не продаёт данные и не использует работы для рекламы или обучения моделей. Полка сама ничего не отправляет разработчикам ИИ: агент сотрудника работает по вашему договору с его поставщиком.",
  },
  {
    q: "Сколько это стоит?",
    a: "Облако polochka.app бесплатно на время пилота. Своя установка по открытой лицензии бесплатна. Коммерческая лицензия и поддержка — по договорённости: фиксированного прайса пока нет.",
  },
];

/** The page for companies: value, deployment, questions and the request form. */
export function EnterpriseContent({
  search = typeof location === "undefined" ? "" : location.search,
}: {
  search?: string;
}) {
  const [interest, setInterest] = useState<EnterpriseInterest | "">(() =>
    initialInterest(search),
  );
  const choose = (value: EnterpriseInterest) => () => setInterest(value);
  return (
    <>
      <section className="enterprise-hero">
        <div>
          <span className="eyebrow">Полка для компаний</span>
          <h1>Всё, что сотрудники делают с&nbsp;ИИ, — в&nbsp;одном месте</h1>
          <p>
            Продажи работают в ChatGPT, аналитики — в Claude, разработчики — в
            Codex и Claude Code. Агент каждого сам сохраняет отчёты, расчёты и
            прототипы на Полку вашей компании: с версиями, поиском по тексту и
            ссылками, которые можно отозвать. Утверждённые шаблоны — в общей
            библиотеке команды.
          </p>
          <div className="enterprise-hero-actions">
            <LinkButton variant="primary" href="#request">
              Оставить заявку <ArrowDown size={18} />
            </LinkButton>
            <LinkButton href="#deploy">Варианты установки</LinkButton>
          </div>
          <ul className="enterprise-facts" aria-label="Коротко">
            <li>Открытый код, {SOURCE_LICENSE}</li>
            <li>Данные в России на polochka.app</li>
            <li>Можно поставить у себя</li>
          </ul>
        </div>
        <figure className="enterprise-shelf" aria-hidden="true">
          {[
            {
              title: "Квартальный отчёт",
              meta: "Версия 4 · SHA-256 3f9a…c21e",
              tag: "Claude",
            },
            {
              title: "Прототип онбординга",
              meta: "Ссылка до 1 октября · отозвать",
              tag: "Codex",
            },
            {
              title: "Дашборд обращений",
              meta: "Шаблон «Отчёт команды», версия 2",
              tag: "ChatGPT",
            },
          ].map((item) => (
            <div key={item.title} className="enterprise-shelf-item">
              <span className="enterprise-shelf-cover" />
              <span>
                <strong>{item.title}</strong>
                <small>{item.meta}</small>
              </span>
              <em>{item.tag}</em>
            </div>
          ))}
          <figcaption>Полка сотрудника: работы из трёх агентов</figcaption>
        </figure>
      </section>

      <section className="enterprise-how" aria-labelledby="enterprise-how-title">
        <h2 id="enterprise-how-title">Как это работает в компании</h2>
        <ol>
          {HOW.map((step, index) => (
            <li key={step.title}>
              <span className="enterprise-icon">{step.icon}</span>
              <small>{String(index + 1).padStart(2, "0")}</small>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="enterprise-values"
        aria-labelledby="enterprise-values-title"
      >
        <h2 id="enterprise-values-title">Что уже работает</h2>
        <div className="enterprise-grid">
          {VALUES.map((value) => (
            <article key={value.title}>
              <span className="enterprise-icon">{value.icon}</span>
              <h3>
                {value.title} {value.badge}
              </h3>
              <ul>
                {value.points.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section
        className="enterprise-next"
        aria-labelledby="enterprise-next-title"
      >
        <h2 id="enterprise-next-title">Коммерческая редакция</h2>
        <p className="enterprise-next-lead">
          Всё выше — открытое ядро, бесплатно. Для организаций есть
          коммерческая редакция: расширение ядра по договору и с ключом
          лицензии. Облако polochka.app работает на открытом ядре.{" "}
          <a href="#request">Напишите в заявке</a>, что нужно вам.
        </p>
        <div className="enterprise-grid">
          {NEXT.map((item) => (
            <article key={item.title}>
              <span className="enterprise-icon">{item.icon}</span>
              <h3>
                {item.title}{" "}
                {item.ready ? <Badge tone="success">есть</Badge> : <InProgress />}
              </h3>
              <ul>
                {item.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section
        id="deploy"
        className="enterprise-deploy"
        aria-labelledby="enterprise-deploy-title"
      >
        <h2 id="enterprise-deploy-title">Как развернуть</h2>
        <div className="enterprise-plans">
          <article>
            <span className="enterprise-icon">
              <Cloud />
            </span>
            <h3>Облако polochka.app</h3>
            <strong className="enterprise-price">
              Бесплатно на время пилота
            </strong>
            <p>
              Ничего не нужно устанавливать. Данные хранятся в России, работа —
              по пользовательскому соглашению и политике обработки данных.
            </p>
            <div className="enterprise-plan-actions">
              <LinkButton href="#request" onClick={choose("cloud")}>
                Оставить заявку
              </LinkButton>
              <a href="/terms">Соглашение</a>
            </div>
          </article>
          <article>
            <span className="enterprise-icon">
              <Server />
            </span>
            <h3>Своя установка</h3>
            <strong className="enterprise-price">
              Бесплатно по {SOURCE_LICENSE}
            </strong>
            <p>
              Docker-образ, PostgreSQL и S3-совместимое хранилище на ваших
              серверах или в российском облаке. Отдельный домен просмотра для
              интерактивных страниц.
            </p>
            <div className="enterprise-plan-actions">
              <LinkButton href="#request" onClick={choose("self-hosted")}>
                Оставить заявку
              </LinkButton>
              <a
                href={`${SOURCE_URL}/blob/main/deploy/hosted/README.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Инструкция
              </a>
            </div>
          </article>
          <article>
            <span className="enterprise-icon">
              <Handshake />
            </span>
            <h3>Коммерческая лицензия и поддержка</h3>
            <strong className="enterprise-price">По договорённости</strong>
            <p>
              Без обязанности публиковать изменения, со встраиванием в закрытый
              продукт, с гарантиями, поддержкой и SLA по договору.
            </p>
            <div className="enterprise-plan-actions">
              <LinkButton
                variant="primary"
                href="#request"
                onClick={choose("commercial-license")}
              >
                Оставить заявку
              </LinkButton>
              <a
                href={`${SOURCE_URL}/blob/main/COMMERCIAL.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Условия
              </a>
            </div>
          </article>
        </div>
        <p className="enterprise-fine">
          Чем отличаются варианты и кому нужна лицензия —{" "}
          <a href="/pricing">на странице вариантов</a>.
        </p>
      </section>

      <section
        className="enterprise-faq"
        aria-labelledby="enterprise-faq-title"
      >
        <h2 id="enterprise-faq-title">Вопросы</h2>
        <div>
          {FAQ.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section
        id="request"
        className="enterprise-request"
        aria-labelledby="enterprise-request-title"
      >
        <div className="enterprise-request-lead">
          <h2 id="enterprise-request-title">Оставить заявку</h2>
          <p>
            Расскажите, как хотите использовать Полку. Ответим на рабочую почту:
            обсудим установку, лицензию, поддержку и сроки.
          </p>
          <p className="enterprise-contact">
            Или напишите напрямую: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
          </p>
          <a
            className="enterprise-source"
            href={SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Код Полки на GitHub <ArrowUpRight size={16} />
          </a>
        </div>
        <EnterpriseForm interest={interest} onInterest={setInterest} />
      </section>
    </>
  );
}
