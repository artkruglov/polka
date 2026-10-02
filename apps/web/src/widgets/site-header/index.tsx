import { useSourceUrl } from "../../entities/capabilities/useCapabilities.ts";
import { useSourceStars } from "../../entities/capabilities/useSourceStars.ts";
import { formatStars, onGitHub } from "../../shared/lib/project-links.ts";
import "./styles.css";
import React from "react";
import { ArrowRight } from "lucide-react";
import { GitHubMark } from "../../shared/ui/GitHubMark.tsx";

/** The marketing header: the brand, the few places a visitor goes, and the one action. */
/** `home` keeps the section anchors on the landing itself; elsewhere they point back to it. */
export function SiteHeader({ signedIn, home = false }: { signedIn: boolean; home?: boolean }) {
  const sourceUrl = useSourceUrl();
  const github = onGitHub(sourceUrl);
  const stars = formatStars(useSourceStars());
  const base = home ? "" : "/";
  return (
    <header className="mkt-header">
      <div className="mkt-header-inner">
        <a className="brand" href="/" aria-label="Полка — главная">
          полка
        </a>
        <nav className="mkt-nav" aria-label="Разделы">
          <a href={`${base}#how`}>Как это работает</a>
          <a href={`${base}#can`}>Возможности</a>
          <a href="/discover">Лента</a>
          <a href="/enterprise">Для компаний</a>
        </nav>
        <div className="mkt-header-actions">
          <a
            className="mkt-source"
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={stars ? `Открытый код, ${stars} звёзд` : "Открытый код"}
          >
            {github && <GitHubMark size={18} />}
            <span>{stars ? `★ ${stars}` : "Код"}</span>
          </a>
          {signedIn ? (
            <a className="mkt-button mkt-button--primary" href="/">
              Моя полка <ArrowRight aria-hidden="true" size={16} />
            </a>
          ) : (
            <>
              <a className="mkt-login" href={`/?login=1&next=${encodeURIComponent("/")}`}>
                Войти
              </a>
              <a className="mkt-button mkt-button--primary" href={`${base}#connect`}>
                Подключить агента
              </a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
