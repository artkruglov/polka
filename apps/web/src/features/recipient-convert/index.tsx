import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Sparkles, WandSparkles, X } from "lucide-react";
import type { Revision } from "../../../../../packages/contracts/index.ts";
import { Button, IconButton } from "../../shared/ui/controls.tsx";
import { useCopy } from "../../shared/ui/CopyText.tsx";
import {
  trackRecipientCta,
  type RecipientCtaAction,
  type RecipientCtaPage,
} from "../../shared/api/recipient-cta.ts";
import { setVisitSourceRef } from "../../shared/lib/visit-source.ts";
import {
  rememberShareForSignIn,
  SHARE_RETURN_PATH,
} from "../../shared/lib/share-return.ts";
import { connectPhrase } from "../../entities/onboarding/connect-phrase.ts";
import {
  markCardDismissed,
  markCardShown,
  mayAutoOpen,
  readCardState,
} from "../../entities/recipient-convert/card-state.ts";
import { remixPrompt } from "../../entities/recipient-convert/remix-prompt.ts";
import { rememberConvertReturn } from "../../entities/recipient-convert/return.ts";

/*
 * A guest's way in from someone's work (docs/specs/RECIPIENT_CONVERSION.md):
 * a bar under the work («Эту страницу сделали с ИИ и сохранили на Полку»)
 * and a card that slides in once per browser, or when a bar button is
 * pressed. No modal, no page block: the work stays readable. Used by the
 * recipient page (/s, page "share") and the feed material page (/discover,
 * page "feed"). The CSS is imported by those pages, because Node tests
 * render these components.
 */

export type ConvertVariant = "try" | "remix";
export type ConvertPage = RecipientCtaPage;

/** The sign-up source and the phrase's ?ref=: share | share-remix | feed | feed-remix. */
export const variantRef = (variant: ConvertVariant, page: ConvertPage = "share") =>
  variant === "remix" ? `${page}-remix` : page;

/** Seconds of reading before the card opens on its own. */
export const AUTO_OPEN_MS = 15_000;

type CardRequest = { variant: ConvertVariant; opener: HTMLElement | null };

/** The sign-in page, returning to /s; a share's token travels in this tab only. */
export const SIGN_UP_HREF = `/signup?next=${encodeURIComponent(SHARE_RETURN_PATH)}`;

/** Where a sign-up started on this page comes back to. */
export type ConvertReturn =
  | { token: string }
  /** A plain path with nothing secret in it (a feed material). */
  | { path: string };

const signUpHref = (back: ConvertReturn) =>
  "path" in back ? `/signup?next=${encodeURIComponent(back.path)}` : SIGN_UP_HREF;

const rememberReturn = (back: ConvertReturn) => {
  if ("path" in back) rememberConvertReturn(back.path);
  else rememberShareForSignIn(back.token);
};

/**
 * Just before the browser leaves for a sign-in provider from the card: the
 * press is counted and the way back kept (a share's token never in the URL).
 */
export function leaveForProvider(
  back: ConvertReturn,
  variant: ConvertVariant,
  page: ConvertPage = "share",
) {
  setVisitSourceRef(variantRef(variant, page));
  trackRecipientCta({ event: "click", action: "yandex", page });
  rememberReturn(back);
}

/**
 * When the card opens: a bar button, or (once per browser) 15 s of viewing
 * or a first interaction with the work. The stage ref goes on the element
 * that holds the work; the frame inside it takes focus when touched, which
 * the window sees as its own blur.
 */
export function useRecipientConvert({
  enabled,
  page = "share",
}: {
  enabled: boolean;
  page?: ConvertPage;
}) {
  const [card, setCard] = useState<CardRequest | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    trackRecipientCta({ event: "view", surface: "bar", page });
  }, [enabled, page]);

  const open = useCallback(
    (variant: ConvertVariant, opener: HTMLElement | null) => {
      // The source of a sign-up that starts here (the provider link is built
      // when the card renders, so the ref is set before that).
      setVisitSourceRef(variantRef(variant, page));
      markCardShown();
      trackRecipientCta({ event: "view", surface: "card", page });
      setCard({ variant, opener });
    },
    [page],
  );

  useEffect(() => {
    if (!enabled || card || !mayAutoOpen(readCardState())) return;
    let done = false;
    const stage = stageRef.current;
    const fire = () => {
      if (done) return;
      done = true;
      cleanup();
      open("try", null);
    };
    const timer = setTimeout(fire, AUTO_OPEN_MS);
    const touches = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
    for (const name of touches)
      stage?.addEventListener(name, fire, { passive: true, once: true });
    window.addEventListener("scroll", fire, { passive: true, once: true });
    const onBlur = () => {
      // Focus moved into the work's frame: the reader started using it.
      setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement && stage?.contains(active)) fire();
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    const cleanup = () => {
      clearTimeout(timer);
      for (const name of touches) stage?.removeEventListener(name, fire);
      window.removeEventListener("scroll", fire);
      window.removeEventListener("blur", onBlur);
    };
    return cleanup;
  }, [enabled, card !== null, open]);

  const close = useCallback(() => {
    markCardDismissed();
    setCard((current) => {
      current?.opener?.focus();
      return null;
    });
  }, []);

  return {
    stageRef,
    card,
    /** A bar button: counts the press, then opens the matching card. */
    press: (variant: ConvertVariant, opener: HTMLElement | null) => {
      trackRecipientCta({ event: "click", action: variant, page });
      open(variant, opener);
    },
    close,
  };
}

/** The persistent bar under the work, for guests only. */
export function ConvertBar({
  onTry,
  onRemix,
}: {
  onTry: (opener: HTMLElement) => void;
  onRemix: (opener: HTMLElement) => void;
}) {
  // The bar stays while the card is open, so the stage never jumps; a press
  // then simply switches the card to the other variant.
  return (
    <aside className="convert-bar" aria-label="Полка">
      <span className="convert-bar-icon" aria-hidden="true">
        <Sparkles />
      </span>
      <p className="convert-bar-text">
        Эту страницу сделали с ИИ и сохранили на Полку
      </p>
      <div className="convert-bar-actions">
        <Button
          variant="primary"
          className="convert-bar-try"
          onClick={(event) => onTry(event.currentTarget)}
        >
          Попробовать бесплатно
        </Button>
        <Button
          variant="secondary"
          className="convert-bar-remix"
          title="Сделать такую же"
          aria-label="Сделать такую же"
          onClick={(event) => onRemix(event.currentTarget)}
        >
          <WandSparkles aria-hidden="true" />
          <span>Сделать такую же</span>
        </Button>
      </div>
    </aside>
  );
}

function CopyLine({
  value,
  label,
  onCopied,
  variant = "secondary",
}: {
  value: string;
  label: string;
  onCopied?: () => void;
  variant?: "primary" | "secondary";
}) {
  const { state, copy } = useCopy(value);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        busy={state === "copying"}
        onClick={async () => {
          onCopied?.();
          await copy();
        }}
      >
        {state === "copied" ? <Check /> : <Copy />}{" "}
        {state === "copied" ? "Скопировано" : label}
      </Button>
      {state === "failed" && (
        <span className="field-note" role="status">
          Браузер не дал скопировать — выделите текст вручную.
        </span>
      )}
    </>
  );
}

/**
 * The card: three ways to a shelf of one's own. Not a modal: the work
 * behind it keeps working, Escape or «Закрыть» hides it, and the choice is
 * remembered in this browser.
 */
export function ConvertCard({
  variant,
  page = "share",
  origin,
  revision,
  back,
  signIn,
  onClose,
}: {
  variant: ConvertVariant;
  page?: ConvertPage;
  origin: string;
  revision: Pick<Revision, "mime" | "htmlProfile" | "inlineBuild">;
  /** Where a sign-up comes back to: a share's token (kept in this tab, never in a URL) or a plain path. */
  back: ConvertReturn;
  /** «Войти с Яндекс ID», when the installation has it (the page composes it). */
  signIn?: React.ReactNode;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [variant]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const ref = variantRef(variant, page);
  const phrase = connectPhrase(origin, ref);
  const prompt = remixPrompt(origin, revision, ref);
  const count = (action: RecipientCtaAction) => () => {
    setVisitSourceRef(ref);
    trackRecipientCta({ event: "click", action, page });
  };
  const leave = (action: RecipientCtaAction) => () => {
    count(action)();
    rememberReturn(back);
  };
  const remix = variant === "remix";
  return (
    <section
      className="convert-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby="convert-card-title"
      data-variant={variant}
    >
      <header className="convert-card-head">
        <h2 id="convert-card-title" ref={heading} tabIndex={-1}>
          {remix ? "Сделайте такую же с вашим агентом" : "Сохраняйте свои работы с ИИ так же"}
        </h2>
        <IconButton label="Закрыть" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <p className="convert-card-lead">
        {remix
          ? "Скопируйте запрос агенту. Он сделает работу и сохранит её на вашу полку; Полка бесплатна на время пилота."
          : "Агент сохраняет страницы сам, вы делитесь ссылкой. Полка бесплатна на время пилота."}
      </p>
      <ol className="convert-paths">
        <li className="convert-path">
          <strong>{remix ? "Запрос для агента" : "Скопируйте своему агенту"}</strong>
          <div className="convert-phrase" data-long={remix || undefined}>
            <code>{remix ? prompt : phrase}</code>
            <CopyLine
              value={remix ? prompt : phrase}
              label={remix ? "Скопировать запрос" : "Скопировать"}
              variant="primary"
              onCopied={count("copy_phrase")}
            />
          </div>
          {!remix && (
            <small>
              Агент выполнит одну команду, Полка откроется в браузере, вы нажмёте «Разрешить».
            </small>
          )}
        </li>
        {signIn && (
          <li className="convert-path">
            <strong>{remix ? "Нет полки? Войдите одним нажатием" : "Или войдите одним нажатием"}</strong>
            {signIn}
          </li>
        )}
        <li className="convert-path convert-path--email">
          <a href={signUpHref(back)} onClick={leave("email")}>
            {signIn ? "или по почте" : "Создать полку по почте"} <ArrowUpRight size={14} />
          </a>
        </li>
      </ol>
    </section>
  );
}

/**
 * Back on the work after a sign-up that started here: the shelf exists, the
 * agent is one phrase away, and «Моя полка» is a link, not a redirect.
 */
export function SignedInFromShare({
  created,
  origin,
  page = "share",
  onClose,
}: {
  /** The account is minutes old (a sign-up), not an old one signing in. */
  created: boolean;
  origin: string;
  page?: ConvertPage;
  onClose: () => void;
}) {
  const phrase = connectPhrase(origin, page);
  return (
    <div className="convert-welcome" role="status">
      <div className="convert-welcome-text">
        <strong>{created ? "Полка создана." : "Вы вошли в Полку."}</strong>{" "}
        Подключите агента одной фразой:
        <code className="convert-welcome-phrase">{phrase}</code>
      </div>
      <div className="convert-welcome-actions">
        <CopyLine value={phrase} label="Скопировать фразу" />
        <a className="convert-welcome-link" href="/">
          Моя полка <ArrowUpRight size={14} />
        </a>
        <IconButton label="Скрыть" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}
