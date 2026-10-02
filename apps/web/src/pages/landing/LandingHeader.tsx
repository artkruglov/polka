import React from "react";
import { ArrowRight } from "lucide-react";
import { GitHubMark } from "../../shared/ui/GitHubMark.tsx";

/** The marketing header: the brand, the few places a visitor goes, and the one action. */
export function LandingHeader({
  signedIn,
  sourceUrl,
  onGitHub,
  stars,
}: {
  signedIn: boolean;
  sourceUrl: string;
  onGitHub: boolean;
  stars: string | null;
}) {
  return (
    <header className="lp-header">
      <div className="lp-header-inner">
        <a className="brand" href="/" aria-label="Полка — главная">
          полка
        </a>
        <nav className="lp-nav" aria-label="Разделы">
          <a href="#how">Как это работает</a>
          <a href="#can">Возможности</a>
          <a href="/discover">Лента</a>
          <a href="/enterprise">Для компаний</a>
        </nav>
        <div className="lp-header-actions">
          <a
            className="lp-source"
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={stars ? `Открытый код, ${stars} звёзд` : "Открытый код"}
          >
            {onGitHub && <GitHubMark size={18} />}
            <span>{stars ? `★ ${stars}` : "Код"}</span>
          </a>
          {signedIn ? (
            <a className="lp-button lp-button--primary" href="/">
              Моя полка <ArrowRight aria-hidden="true" size={16} />
            </a>
          ) : (
            <>
              <a className="lp-login" href={`/?login=1&next=${encodeURIComponent("/")}`}>
                Войти
              </a>
              <a className="lp-button lp-button--primary" href="#connect">
                Подключить агента
              </a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
