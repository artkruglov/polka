import "./styles.css";
import { Button, ChoiceCard, IconButton, LinkButton, SelectField } from "../../shared/ui/controls.tsx";
import React, { useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Globe,
  Hourglass,
  Link as LinkIcon,
  LockKeyhole,
  Send,
  ShieldCheck,
} from "lucide-react";
import type { Artifact } from "../../../../../packages/contracts/index.ts";
import { client } from "../../shared/api/client.ts";
import {
  dateLong,
  kindOf,
  moderationNote,
  size,
} from "../../entities/artifact/format.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { useSignInWays } from "../../entities/capabilities/useCapabilities.ts";
import { useCopy } from "../../shared/ui/CopyText.tsx";

type Choice = "private" | "link";

/** Who can open: private, by link, or published (after review — operator-only today). */
export function SharePanel({
  artifact: a,
  onClose,
  onChange,
  provisional = false,
}: {
  artifact: Artifact;
  onClose: () => void;
  onChange: () => Promise<void>;
  /**
   * A provisional shelf (docs/specs/SIGN_IN_PROVIDERS.md § 8) gives no links
   * until it is claimed: the link step leads to /claim instead.
   */
  provisional?: boolean;
}) {
  const ways = useSignInWays();
  const active = !!a.share && ["active", "behind"].includes(a.share.status);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [choice, setChoice] = useState<Choice>(active ? "link" : "private"),
    [days, setDays] = useState(7);
  const url = a.share?.url ?? "";
  // «Скопировано» belongs to this address; a new link starts uncopied.
  const clip = useCopy(url);
  const copied = clip.state === "copied";
  // The radio reflects the saved state; a pending change shows its own confirmation below.
  const wantsLink = choice === "link" && !active;
  const wantsClose = choice === "private" && active;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if ((await clip.copy()) === "failed")
      setError("Не удалось скопировать. Выделите адрес выше.");
  };
  const telegram = url
    ? `https://t.me/share/url?url=${encodeURIComponent(url)}`
    : null;
  return (
    <Dialog title="Поделиться" onClose={onClose} busy={busy}>
      <div className="dialog-body share-panel">
        <div className="share-material">
          <span className="share-material-icon" aria-hidden="true">
            {active ? <LinkIcon /> : <LockKeyhole />}
          </span>
          <div>
            <strong>{a.title}</strong>
            <span>
              {kindOf(a.revision)} · v{a.revision.number} · {size(a.revision.size)}
            </span>
          </div>
        </div>

        <fieldset className="share-choices">
          <legend>Кто может открыть</legend>
          <div className="ui-choice-list">
            <ChoiceCard
              name="share-access"
              value="private"
              checked={choice === "private"}
              icon={<LockKeyhole />}
              title="Только я"
              description="Видно только вам"
              onChange={() => setChoice("private")}
            />
            <ChoiceCard
              name="share-access"
              value="link"
              checked={choice === "link"}
              icon={<LinkIcon />}
              title="По ссылке"
              description="Откроет любой, у кого есть ссылка"
              onChange={() => setChoice("link")}
            />
            <ChoiceCard
              name="share-access"
              value="public"
              checked={false}
              disabled
              icon={<Globe />}
              title={<>Опубликовать <small className="share-soon">после проверки</small></>}
              description="В «Ленте» после проверки редакцией Полки. Пока публикует оператор."
              onChange={() => undefined}
            />
          </div>
        </fieldset>

        {wantsLink && provisional && (
          <div className="share-step share-step--warn" role="note">
            <strong>Полка ещё не закреплена.</strong>
            <p>
              Ссылки выдаются после входа {ways.via}: так требует закон. Работа сохранена и видна только вам.
            </p>
          </div>
        )}
        {wantsLink && !provisional && (
          <div className="share-step">
            <p>
              {a.share?.status === "revoked"
                ? "Старая ссылка закрыта навсегда. Создадим новый адрес."
                : a.share?.status === "expired"
                  ? "Срок прежней ссылки истёк. Создадим новый адрес."
                  : "Получателю не нужен вход в Полку и аккаунт в Claude или ChatGPT."}
            </p>
            <SelectField
              label="Срок доступа"
              value={days}
              onChange={(e) => setDays(+e.target.value)}
              hint="Индексация отключена, но это не закрытое приглашение: доступ получит любой, кому передали ссылку."
            >
              <option value={1}>1 день</option>
              <option value={7}>7 дней</option>
              <option value={30}>30 дней</option>
            </SelectField>
          </div>
        )}

        {active && choice === "link" && (
          <div className="share-step">
            <span className="share-label">Ссылка на работу</span>
            {url ? (
              <>
                <div className="ui-link-field">
                  <code>{url}</code>
                  <IconButton label={copied ? "Скопировано" : "Скопировать ссылку"} onClick={() => void copy()}>
                    {copied ? <Check /> : <Copy />}
                  </IconButton>
                </div>
                <Button variant="primary" className="ui-button--lg share-copy" onClick={() => void copy()}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Скопировано" : "Скопировать ссылку"}
                </Button>
              </>
            ) : (
              <p className="fine" role="note">
                Адрес ссылки сейчас недоступен. Закройте окно и откройте его
                снова.
              </p>
            )}
            {telegram && (
              <LinkButton href={telegram} target="_blank" rel="noopener" className="ui-button--lg share-telegram">
                <Send /> Отправить в Telegram
              </LinkButton>
            )}
            {moderationNote(a) && (
              <p className="share-moderation" role="status">
                <Hourglass aria-hidden="true" />
                <span>{moderationNote(a)}</span>
              </p>
            )}
            <p className="fine">
              Получатель видит версию {a.share!.number}. Действует до {dateLong(a.share!.expiresAt)}. Поисковикам передаётся запрет индексации.
            </p>
            {a.share!.status === "behind" && (
              <div className="share-update">
                <div>
                  <strong>На полке уже версия {a.revision.number}</strong>
                  <p>По отправленной ссылке пока открывается версия {a.share!.number}.</p>
                </div>
                <Button onClick={() => run(() => client.publish(a))} disabled={busy}>
                  Обновить до v{a.revision.number} <ArrowUpRight />
                </Button>
              </div>
            )}
          </div>
        )}

        {wantsClose && (
          <div className="share-step share-step--warn" role="alert">
            <strong>Закрыть доступ по этой ссылке?</strong>
            <p>Следующее открытие будет недоступно. Уже полученную копию отозвать нельзя.</p>
          </div>
        )}

        <p className="share-review">
          <ShieldCheck aria-hidden="true" />
          <span>
            <strong>Публикация — после проверки.</strong> Ваши работы не попадают в «Ленту» сами; по умолчанию их видите только вы.
          </span>
        </p>
        <ErrorNotice error={error} />
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose} disabled={busy}>
          {wantsLink || wantsClose ? "Отмена" : "Готово"}
        </Button>
        {wantsLink && provisional && (
          <LinkButton href="/claim" variant="primary">
            <ShieldCheck /> Закрепить, чтобы поделиться
          </LinkButton>
        )}
        {wantsLink && !provisional && (
          <Button variant="primary" busy={busy} onClick={() => run(() => client.enable(a, days))}>
            <LinkIcon /> {a.share ? "Создать новую ссылку" : "Включить доступ по ссылке"}
          </Button>
        )}
        {wantsClose && (
          <Button
            variant="primary"
            className="share-close"
            busy={busy}
            onClick={() => run(() => client.revoke(a.share!.id))}
          >
            Закрыть доступ
          </Button>
        )}
      </div>
    </Dialog>
  );
}
