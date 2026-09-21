import React, { useEffect, useState } from "react";
import type { AgentContext } from "../../../../../packages/contracts/agent-context.ts";
import { request } from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import {
  Button,
  LinkButton,
  SelectField,
  TextField,
  TextAreaField,
} from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import "./styles.css";
export function AgentContextPanel({
  artifactId,
  revisionId,
  libraryId,
  publicationId,
  onClose,
}: {
  artifactId: string;
  revisionId: string;
  libraryId?: string;
  publicationId?: string;
  onClose: () => void;
}) {
  const [purpose, setPurpose] = useState(""),
    [context, setContext] = useState<AgentContext | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [summary, setSummary] = useState(""),
    [rules, setRules] = useState(""),
    [questions, setQuestions] = useState("");
  useEffect(() => {
    let live = true;
    setContext(null);
    setError("");
    request<AgentContext>(
      `/artifacts/${artifactId}/agent-context?${new URLSearchParams({ revisionId, ...(libraryId ? { libraryId } : {}), ...(publicationId ? { publicationId } : {}), ...(purpose ? { purpose } : {}) })}`,
    )
      .then((x) => {
        if (live) setContext(x);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [artifactId, revisionId, libraryId, publicationId, purpose, refresh]);
  const imageOnly =
    context !== null &&
    context.availableContent.length > 0 &&
    context.availableContent.every((file) => file.mime.startsWith("image/"));
  return (
    <Dialog title="Скопировать для агента" onClose={onClose}>
      <div className="dialog-body agent-context-panel">
        <ErrorNotice error={error} />
        {!context && !error && <p role="status">Получаем выбранную версию…</p>}
        {context && (
          <>
            <h3>
              {context.title} · v{context.revisionNumber}
            </h3>
            {imageOnly && (
              <p className="fine">
                Визуальный пример · доступны только изображения. Это ориентир по
                внешнему виду, а не редактируемый стиль или набор ресурсов.
              </p>
            )}
            <p>
              {context.summary ||
                "Добавьте материал в текущий чат. Задачу и другие источники опишите там."}
            </p>
            {context.releaseId && (
              <p className="fine">Шаблон · выпуск закреплён за этой версией</p>
            )}
            <SelectField
              label="Как использовать"
              value={context.purpose}
              onChange={(e) => setPurpose(e.target.value)}
            >
              <option value="base">Взять за основу</option>
              <option value="source">Использовать как источник</option>
              <option value="style">{imageOnly ? "Использовать как визуальный пример" : "Взять оформление"}</option>
            </SelectField>
            <CopyText
              key={context.clipboardText}
              label="Текст для агента"
              value={context.clipboardText}
              rows={7}
              collapsible
              buttonLabel="Скопировать для агента"
              successText="Скопировано. Вставьте в чат своего агента"
            />
            <p className="fine">
              Копирование не запускает агента и не меняет доступ. Для чтения
              через MCP нужно разрешение «Читать исходники и шаблоны».
            </p>
            <details>
              <summary>
                {imageOnly ? "Визуальный пример" : "Состав и отдельные файлы"} ·{" "}
                {context.availableContent.length}
              </summary>
              <ul>
                {context.availableContent.map((f) => (
                  <li key={f.path}>
                    <a
                      href={`/api/artifacts/${artifactId}/agent-file?${new URLSearchParams({ revisionId: context.revisionId, path: f.path, ...(context.libraryId ? { libraryId: context.libraryId } : {}), ...(context.publicationId ? { publicationId: context.publicationId } : {}) })}`}
                      download
                    >
                      {f.path}
                    </a>{" "}
                    <small>
                      {f.mime} · {f.size} Б
                    </small>
                  </li>
                ))}
              </ul>
            </details>
            <section>
              <h3>Агент не подключён к Полке?</h3>
              <p>
                Скачайте пакет и приложите к чату. Если агент не читает ZIP,
                распакуйте его или скачайте нужные файлы выше.
              </p>
              <LinkButton href={context.sourceAccess.packageUrl} download>
                Скачать пакет
              </LinkButton>{" "}
              <LinkButton href="/settings/agents" variant="quiet">
                Подключить агента
              </LinkButton>
              <p className="fine">
                Отзыв доступа не удалит уже скачанные копии.
              </p>
            </section>
            <details>
              <summary>Правила и вопросы шаблона</summary>
              <p className="context-pre">
                {context.rules || "Опубликованных правил нет."}
              </p>
              <p className="context-pre">{context.questions}</p>
            </details>
            {!context.releaseId && (
              <Button onClick={() => setEdit(!edit)}>
                Сохранить эту версию как шаблон
              </Button>
            )}
            {edit && !context.releaseId && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (busy) return;
                  setBusy(true);
                  setError("");
                  try {
                    await request(
                      `/artifacts/${artifactId}/template-releases`,
                      { revisionId, summary, rules, questions },
                    );
                    setEdit(false);
                    setPurpose("");
                    setRefresh((x) => x + 1);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <p>
                  Закрепите правила для повторного использования. Шаблон
                  останется в вашей Полке; публичная ссылка не создаётся.
                  Правила выпуска неизменяемы — для изменений нужна новая версия
                  материала.
                </p>
                <TextField
                  label="Для каких случаев"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  maxLength={600}
                  required
                />
                <TextAreaField
                  label="Правила оформления и использования"
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                  maxLength={6000}
                  required
                  rows={4}
                />
                <TextAreaField
                  label="Что агенту уточнить, если данных нет в чате"
                  value={questions}
                  onChange={(e) => setQuestions(e.target.value)}
                  maxLength={3000}
                  rows={3}
                />
                <Button type="submit" busy={busy} variant="primary">
                  Закрепить шаблон v{context.revisionNumber}
                </Button>
              </form>
            )}
            <LinkButton
              href={
                libraryId
                  ? `/templates?libraryId=${encodeURIComponent(libraryId)}`
                  : "/templates"
              }
              variant="quiet"
            >
              {libraryId ? "Шаблоны библиотеки" : "Мои шаблоны"}
            </LinkButton>
          </>
        )}
        {!context && error && (
          <Button onClick={() => setRefresh((x) => x + 1)}>Повторить</Button>
        )}
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose}>Закрыть</Button>
      </div>
    </Dialog>
  );
}
