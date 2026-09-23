import React from "react";
import { ArrowUpRight, Cloud, Mail, Server } from "lucide-react";
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
          облаке, поставить Полку у себя или взять коммерческую лицензию, если
          открытые условия не подходят.
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
          <h2>Коммерческая лицензия</h2>
          <strong className="pricing-price">Цена по договорённости</strong>
          <p>
            Нужна, если вы запускаете изменённую Полку как сервис и не хотите
            публиковать изменения, встраиваете её в закрытый продукт или вам
            нужны гарантии, поддержка и SLA по договору. Пользоваться Полкой без
            изменений или дорабатывать её открыто можно без лицензии.
          </p>
          <div className="pricing-actions">
            <LinkButton
              variant="primary"
              href={`mailto:${CONTACT}?subject=${encodeURIComponent("Коммерческая лицензия Полки")}`}
            >
              Написать <Mail size={18} />
            </LinkButton>
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

      <p className="pricing-fine">
        Версии до v0.1.0-rc.5 включительно остаются доступны и на условиях
        Apache-2.0. Облако polochka.app — отдельный сервис: лицензия на код к
        нему не относится.
      </p>
    </>
  );
}
