import "./styles.css";
import { pollImport } from "./polling.ts";
import { useFolders } from "../../entities/folder/useFolders.ts";
import React, { useEffect, useRef, useState } from "react";
import { request, ApiError } from "../../shared/api/client.ts";
import { Button, IconButton, LinkButton, SelectField } from "../../shared/ui/controls.tsx";
import { Link2, X } from "lucide-react";
import { classify, type ImportClassification } from "./classify-demo.ts";
import { ProviderGuide } from "./provider-guide.tsx";

type Job = {
  id: string;
  state: string;
  receipt: { artifactId: string } | null;
  warnings: string[];
  errorCode: string | null;
};
const labels: Record<string, string> = {
  queued: "В очереди",
  fetching: "Получаем страницу и ресурсы",
  prepared: "Копия подготовлена",
  saving: "Сохраняем на Полку",
  previewing: "Копия сохранена. Подготавливаем просмотр…",
  ready: "Сохранено. Можно открыть",
  partial: "Сохранено с ограничениями",
  failed: "Не удалось завершить импорт",
  cancelled: "Импорт отменён",
};
const reasons: Record<string, string> = {
  preview_disabled:
    "Интерактивный просмотр выключен на этом сервере. Копия сохранена.",
  preview_unavailable:
    "Копия сохранена, но интерактивный просмотр не подготовлен. Можно открыть материал и проверить ограничения.",
  provider_adapter_required:
    "Ссылки Claude и ChatGPT пока нельзя перенести автоматически. Загрузите экспортированный HTML-файл или передайте файлы через агента.",
  blocked_address: "Адрес не является публичным источником.",
  source_unavailable:
    "Источник недоступен. Возможно, он требует входа или запрещает скачивание.",
  too_large: "Страница вместе с ресурсами превышает допустимый размер.",
  unsupported_type: "По адресу не найдена поддерживаемая HTML-страница.",
  unsupported_encoding:
    "Страница должна быть в кодировке UTF-8. Сохраните её как HTML в UTF-8 и загрузите файлом.",
  unsupported_css:
    "Некоторые ссылки внутри CSS не удалось разобрать. Загрузите подготовленный HTML-пакет через агента.",
  too_many_files:
    "Страница содержит больше 63 внешних ресурсов. Подготовьте автономный HTML-файл.",
  unsupported_asset: "Один из ресурсов имеет неподдерживаемый формат.",
  forbidden: "Подключение или права изменились.",
  timeout: "Источник не ответил вовремя.",
  expired: "Время выполнения задания истекло.",
  retry_exhausted: "Импорт не удалось восстановить после нескольких попыток.",
};
const active = (j: Job | null) =>
  !!j &&
  ["queued", "fetching", "prepared", "saving", "previewing"].includes(j.state);
const storageKey = "polka.active-url-import";
const draftKey = "polka.url-import-draft";
export function UrlImport({
  initial = "",
  initialFolderId = "",
  onFile,
  accountId,
  fileSave,
  pasteCode,
  onProviderChange,
}: {
  initialFolderId?: string;
  initial?: string;
  onFile: () => void;
  accountId?: string;
  fileSave?: React.ReactNode;
  pasteCode?: React.ReactNode;
  /** Tells the page when the Claude/ChatGPT guide (with its own file drop) is showing. */
  onProviderChange?: (active: boolean) => void;
}) {
  const [provider, setProvider] = useState<ImportClassification | null>(() => {
    const recognised = initial ? classify(initial) : null;
    return recognised?.status === "provider" ? recognised : null;
  });
  const [url, setUrl] = useState(
      () => initial || sessionStorage.getItem(draftKey) || "",
    ),
    [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [jobId, setJobId] = useState(() => sessionStorage.getItem(storageKey));
  const folders = useFolders(accountId);
  const [destination, setDestination] = useState({ accountId, folderId: initialFolderId });
  const folderId =
    destination.accountId === accountId ? destination.folderId : initialFolderId;
  const key = useRef(crypto.randomUUID());
  const sending = useRef(false);
  const cancelSending = useRef(false);
  const stopPolling = useRef<() => void>(() => {});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    onProviderChange?.(!!provider);
  }, [provider, onProviderChange]);
  useEffect(() => {
    if (!jobId) return;
    const stop = pollImport<Job>({
      read: () => request<Job>(`/imports/${encodeURIComponent(jobId)}`),
      onValue: (next) => {
        setJob(next);
        setError("");
        setNeedsLogin(false);
        return active(next) ? 1500 : null;
      },
      onError: (e) => {
        setError(
          e instanceof Error ? e.message : "Не удалось проверить импорт.",
        );
        if (e instanceof ApiError && e.status === 401) {
          setNeedsLogin(true);
          setJob(null);
          return null;
        }
        if (e instanceof ApiError && [403, 404].includes(e.status)) {
          sessionStorage.removeItem(storageKey);
          setJobId(null);
          setJob(null);
          setError(
            "Задание недоступно для текущего аккаунта. Проверьте вход или сохраните новую ссылку.",
          );
          return null;
        }
        return 5000;
      },
    });
    stopPolling.current = stop;
    return stop;
  }, [jobId, retry]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    // The server blocks Claude/ChatGPT hosts; show the real path instead of a failing job.
    const recognised = classify(url);
    if (recognised.status === "provider") {
      setProvider(recognised);
      return;
    }
    setProvider(null);
    sending.current = true;
    setNeedsLogin(false);
    setBusy(true);
    setError("");
    try {
      const next = await request<Job>("/imports", {
        key: key.current,
        url,
        ...(folderId ? { folderId } : {}),
      });
      setJob(next);
      setJobId(next.id);
      sessionStorage.setItem(storageKey, next.id);
      sessionStorage.removeItem(draftKey);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        sessionStorage.setItem(draftKey, url);
        setNeedsLogin(true);
      }
      setError(e instanceof Error ? e.message : "Не удалось отправить ссылку.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (!job || cancelSending.current) return;
    cancelSending.current = true;
    stopPolling.current();
    setError("");
    setBusy(true);
    try {
      const next = await request<Job>(
        `/imports/${job.id}`,
        undefined,
        "DELETE",
      );
      setJob(next);
      // Retain the job/receipt until an explicit reset, including a saved copy
      // when cancellation loses the race to finalization.
      if (active(next)) setRetry((value) => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отменить импорт.");
      setRetry((value) => value + 1);
    } finally {
      cancelSending.current = false;
      setBusy(false);
    }
  }
  function reset() {
    stopPolling.current();
    setJob(null);
    setJobId(null);
    sessionStorage.removeItem(storageKey);
    key.current = crypto.randomUUID();
    setError("");
    setNeedsLogin(false);
  }
  return (
    <section className="url-import" aria-labelledby="url-import-title">
      <h2 id="url-import-title" className="sr-only">Сохранить страницу по ссылке</h2>

      {!jobId && (
        <form className="url-import-form" onSubmit={submit}>
          <label className="bring-field">
            <Link2 aria-hidden="true" />
            <input
              id="url-import-input"
              type="url"
              inputMode="url"
              aria-label="Публичная HTTPS-ссылка"
              required
              disabled={busy}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                key.current = crypto.randomUUID();
              }}
              placeholder="https://example.org/report.html"
            />
            {url && !busy && (
              <IconButton size="sm" label="Очистить" onClick={() => setUrl("")}>
                <X />
              </IconButton>
            )}
          </label>
          {accountId && (
            <>
              <SelectField
                label="Куда сохранить"
                value={folderId}
                disabled={busy || folders.loading}
                hint={
                  folders.loading
                    ? "Загружаем папки…"
                    : "Доступ к материалу останется приватным."
                }
                error={folders.error}
                onChange={(e) => {
                  setDestination({ accountId, folderId: e.target.value });
                  key.current = crypto.randomUUID();
                }}
              >
                <option value="">Моя Полка — без папки</option>
                {folderId && !folders.items.some(f => f.id === folderId) && <option value={folderId}>{folders.loading ? "Проверяем выбранную папку…" : "Выбранная папка недоступна"}</option>}
                {folders.items.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </SelectField>
              {folders.error && (
                <Button onClick={folders.retry}>Загрузить папки снова</Button>
              )}
            </>
          )}
          <Button variant="primary" type="submit" busy={busy}>
            Сохранить
          </Button>
        </form>
      )}
      {!jobId && !provider && (
      <details className="url-import-hint">
        <summary>Какие страницы можно перенести</summary>
        <p>
          Публичные HTML-страницы с поддерживаемыми ресурсами. Claude и ChatGPT
          пока требуют экспорта файлом — вставьте такую ссылку, и мы покажем путь.
        </p>
        <p>
          Лучше всего подходят автономные HTML-отчёты, калькуляторы и прототипы.
          Обычные CSS, изображения, WOFF2-шрифты и скрипты копируются вместе со
          страницей. Лимит — 5 МиБ и 64 файла, включая HTML.
        </p>
        <p>
          Внешние API, вход на другом сайте и встроенные страницы не работают в
          изолированном просмотре. Модули JavaScript, CSS @import и адаптивные
          изображения srcset могут потребовать подготовки файлом. Ограничения
          показываем в результате импорта.
        </p>
        <p>
          Наличие интерактивного просмотра не гарантирует работу каждой кнопки:
          проверьте сохранённый материал перед отправкой. Исходную ссылку и
          доступ к источнику получатель не использует.
        </p>
      </details>
      )}
      {jobId && !job && !error && (
        <p role="status">Восстанавливаем состояние импорта…</p>
      )}
      {job && (
        <div className="url-import-status" role="status" aria-live="polite">
          <h3>{labels[job.state] ?? job.state}</h3>
          {job.errorCode && (
            <p>
              {(job.receipt
                ? "Копия сохранена, но просмотр не удалось подготовить. Откройте материал, чтобы проверить его состояние."
                : reasons[job.errorCode]) ??
                "Источник не удалось перенести. Попробуйте сохранить его файлом."}
            </p>
          )}
          {job.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          {job.receipt && (
            <LinkButton
              variant="primary"
              href={`/works/${job.receipt.artifactId}`}
            >
              Открыть сохранённый материал
            </LinkButton>
          )}
          {active(job) ? (
            job.receipt ? (
              <p>
                Можно открыть материал сейчас. Просмотр появится после
                подготовки.
              </p>
            ) : (
              <Button busy={busy} onClick={cancel}>
                Отменить импорт
              </Button>
            )
          ) : (
            <Button onClick={reset}>Сохранить другую ссылку</Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      {needsLogin && (
        <LinkButton
          variant="primary"
          href={`/?login=1&next=${encodeURIComponent(`/bring?url=&folder=${encodeURIComponent(folderId)}`)}`}
        >
          Войти и продолжить со своей ссылкой
        </LinkButton>
      )}
      {jobId && error && !needsLogin && (
        <Button onClick={() => setRetry((value) => value + 1)}>
          Проверить состояние снова
        </Button>
      )}
      {jobId && !job && error && !needsLogin && (
        <p className="url-import-hint">
          Задание остаётся на сервере. Повторная проверка не создаёт новый
          импорт.
        </p>
      )}
      {provider && (
        <ProviderGuide
          result={provider}
          fileSave={fileSave}
          pasteCode={pasteCode}
          onFile={onFile}
        />
      )}
    </section>
  );
}
