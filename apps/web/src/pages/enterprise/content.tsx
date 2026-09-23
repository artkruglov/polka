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
  Server,
  ShieldAlert,
  ShieldCheck,
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
      "На polochka.app данные хранятся в России, в Yandex Cloud.",
      "Интерактивные страницы открываются на отдельном домене просмотра, в песочнице без сети и без cookie Полки.",
      "Ссылки на 1, 7 или 30 дней, отзываются в любой момент.",
      "Каждая версия неизменна и имеет контрольную сумму SHA-256: по ссылке открывается ровно та версия, которой поделились.",
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
      "У каждого сотрудника свой аккаунт и своё подключение с выбранными правами.",
    ],
  },
  {
    icon: <ShieldAlert />,
    title: "Модерация и защита от злоупотреблений",
    points: [
      "Получатель ссылки может пожаловаться на страницу.",
      "При сохранении Полка ищет признаки фишинга: поля паролей и карт рядом с названиями банков или словами срочности.",
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
      "Коммерческая лицензия — если не хотите публиковать свои изменения или встраиваете Полку в закрытый продукт.",
      "Гарантии, поддержка и SLA — по договору.",
    ],
  },
  {
    icon: <KeyRound />,
    title: "Вход через SSO и доступ по домену",
    badge: <InProgress />,
    points: [
      "Сейчас сотрудник входит по коду из письма или по логину от администратора установки.",
      "Вход через корпоративного провайдера и доступ к библиотеке для всех с почтой на домене компании — в разработке.",
      "Если это условие для вас, напишите в заявке: расскажем о сроках.",
    ],
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
        Лицензионного ключа нет: это тот же код.{" "}
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
    q: "Есть ли поддержка и SLA?",
    a: "По открытой лицензии код даётся «как есть», без гарантий. Поддержка, гарантии и SLA — по договору вместе с коммерческой лицензией; объём согласуем.",
  },
  {
    q: "Работает ли вход через SSO?",
    a: "Пока нет, это в разработке. Сейчас сотрудники входят по коду из письма или по логину от администратора установки, у каждого свой аккаунт.",
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
          <h1>Всё, что команда сделала с&nbsp;ИИ, — в&nbsp;одном месте</h1>
          <p>
            Отчёты, прототипы и дашборды, которые сотрудники делают с агентами,
            хранятся на Полке с версиями и ссылками, которые можно отозвать.
            Агент каждого сотрудника — Claude, ChatGPT, Codex или Claude Code —
            сохраняет работу сам.
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
          <figcaption>Пример полки команды</figcaption>
        </figure>
      </section>

      <section
        className="enterprise-values"
        aria-labelledby="enterprise-values-title"
      >
        <h2 id="enterprise-values-title">Что получает компания</h2>
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
