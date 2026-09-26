import React from "react";
import { ArrowRight, ArrowUpRight, Cloud, Mail, Server } from "lucide-react";
import { LinkButton } from "../../shared/ui/controls.tsx";
import { SOURCE_LICENSE, SOURCE_URL } from "../../shared/lib/project-links.ts";

const CONTACT = "hello@polochka.app";

/** «Для компаний»: the three ways to use Полка, with no invented prices. */
export function PricingPlans() {
  return (
    <>
      <header className="pricing-head">
        <span className="eyebrow">Для компаний</span>
        <h1>Как пользоваться Полкой</h1>
        <p>
          Полка — открытый код под лицензией {SOURCE_LICENSE}. Можно работать в
          облаке, поставить открытое ядро у себя или взять коммерческую редакцию
          для организаций.
        </p>
      </header>

      <div className="pricing-plans">
        <article>
          <span className="pricing-icon">
            <Cloud aria-hidden="true" />
          </span>
          <h2>Облако polochka.app</h2>
          <strong className="pricing-price">Бесплатно на время пилота</strong>
          <p>
            Полка на наших серверах: ничего не нужно устанавливать. Условия
            работы — в соглашении и политике обработки данных.
          </p>
          <div className="pricing-actions">
            <LinkButton variant="primary" href="https://polochka.app">
              Открыть polochka.app <ArrowUpRight size={18} />
            </LinkButton>
            <a href="/terms">Соглашение</a>
          </div>
        </article>

        <article>
          <span className="pricing-icon">
            <Server aria-hidden="true" />
          </span>
          <h2>Своя установка</h2>
          <strong className="pricing-price">
            Бесплатно по {SOURCE_LICENSE}
          </strong>
          <p>
            Один Docker-образ, PostgreSQL и S3-совместимое хранилище на вашем
            сервере. Если вы меняете код и даёте пользоваться Полкой другим,
            опубликуйте изменения на условиях {SOURCE_LICENSE} и укажите ссылку
            на них в настройке <code>SOURCE_URL</code>.
          </p>
          <div className="pricing-actions">
            <LinkButton
              href={SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Код на GitHub <ArrowUpRight size={18} />
            </LinkButton>
            <a
              href={`${SOURCE_URL}/blob/main/deploy/hosted/README.md`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Инструкция по установке
            </a>
          </div>
        </article>

        <article>
          <span className="pricing-icon">
            <Mail aria-hidden="true" />
          </span>
          <h2>Коммерческая редакция</h2>
          <strong className="pricing-price">По договору</strong>
          <p>
            Открытое ядро и расширение для организаций: ссылки только для
            сотрудников, политика ссылок и журнал агентов для SIEM, дальше —
            интеграции, SAML и SCIM. С поддержкой и SLA. Коммерческая лицензия на само ядро
            — если нужно не публиковать свои изменения или встроить Полку в
            закрытый продукт.
          </p>
          <div className="pricing-actions">
            <LinkButton
              variant="primary"
              href="/enterprise?interest=commercial-license#request"
            >
              Оставить заявку <ArrowRight size={18} />
            </LinkButton>
            <a
              href={`mailto:${CONTACT}?subject=${encodeURIComponent("Коммерческая лицензия Полки")}`}
            >
              Написать
            </a>
            <a
              href={`${SOURCE_URL}/blob/main/COMMERCIAL.md`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Подробнее об условиях
            </a>
          </div>
        </article>
      </div>

      <section className="pricing-company" aria-labelledby="pricing-company-title">
        <div>
          <h2 id="pricing-company-title">Полка для команды</h2>
          <p>
            Что получает компания, как устроены данные и доступ, ответы на
            частые вопросы и форма заявки.
          </p>
        </div>
        <LinkButton variant="primary" href="/enterprise">
          Для компаний <ArrowRight size={18} />
        </LinkButton>
      </section>

      <p className="pricing-fine">
        Версии до v0.1.0-rc.5 включительно остаются доступны и на условиях
        Apache-2.0. Облако polochka.app — отдельный сервис: лицензия на код к
        нему не относится.
      </p>
    </>
  );
}
