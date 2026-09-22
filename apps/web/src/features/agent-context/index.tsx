import React, { useEffect, useState } from "react";
import { Check, Download, FileCode2, PlugZap } from "lucide-react";
import type { AgentContext } from "../../../../../packages/contracts/agent-context.ts";
import { request } from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import {
  Badge,
  Button,
  LinkButton,
  SelectField,
  TextField,
  TextAreaField,
} from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import "./styles.css";
/** «Для вашего агента»: the copyable context for one version, docked to the right. */
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
  const files = context?.availableContent.length ?? 0;
  const included = context
    ? [
        files > 0 && (imageOnly ? `Визуальный пример · ${files} ${files === 1 ? "файл" : "файла"}` : `Исходники · ${files} ${files === 1 ? "файл" : files < 5 ? "файла" : "файлов"}`),
        context.rules && "Правила оформления и использования",
        context.questions && "Вопросы, которые агент уточнит",
        context.releaseId && "Закреплённый выпуск шаблона",
      ].filter((item): item is string => !!item)
    : [];
  return (
    <Dialog
      variant="panel"
      eyebrow="Для вашего агента"
      title={context ? context.title : "Скопировать для агента"}
      onClose={onClose}
    >
      <div className="dialog-body agent-context-panel">
        <ErrorNotice error={error} />
        {!context && !error && <p role="status">Получаем выбранную версию…</p>}
        {context && (
          <>
            <div className="agent-context-pills">
              <Badge tone="accent">Версия {context.revisionNumber}</Badge>
              {context.releaseId && <Badge>Шаблон</Badge>}
            </div>
            <p className="agent-context-lead">
              {context.summary || "Возьмите за основу в своём чате: задачу и новые материалы опишите там."}
            </p>
            {imageOnly && (
              <p className="fine">
                Доступны только изображения. Это ориентир по внешнему виду, а не
                редактируемый стиль или набор ресурсов.
              </p>
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
            {included.length > 0 && (
              <section className="agent-context-section">
                <h3>Вместе с работой</h3>
                <ul className="ui-checklist">
                  {included.map((item) => (
                    <li key={item}>
                      <span><Check /></span>
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="agent-context-section agent-context-text">
              <h3>Текст для агента</h3>
              <CopyText
                key={context.clipboardText}
                label="Текст для агента"
                value={context.clipboardText}
                rows={6}
                buttonVariant="primary"
                buttonLabel="Скопировать для агента"
                successText="Скопировано. Вставьте в чат своего агента"
              />
              <p className="fine">Вставьте в чат и опишите, что нужно сделать. Копирование не запускает агента и не открывает доступ к работе.</p>
            </section>
            <details className="agent-context-files">
              <summary>
                <FileCode2 />
                {imageOnly ? "Визуальный пример" : "Состав и отдельные файлы"} · {files}
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
            {(context.rules || context.questions) && (
              <details className="agent-context-files">
                <summary>Правила и вопросы шаблона</summary>
                <p className="context-pre">{context.rules || "Опубликованных правил нет."}</p>
                <p className="context-pre">{context.questions}</p>
              </details>
            )}
            <section className="agent-context-section agent-context-offline">
              <h3>Агент не подключён к Полке?</h3>
              <p>Скачайте пакет и приложите его к сообщению. Если агент не читает ZIP, распакуйте его или скачайте нужные файлы выше.</p>
              <div className="agent-context-offline-actions">
                <LinkButton href={context.sourceAccess.packageUrl} download className="ui-button--block">
                  <Download /> Скачать пакет
                </LinkButton>
                <LinkButton href="/settings/agents" variant="quiet" className="ui-button--block">
                  <PlugZap /> Подключить агента
                </LinkButton>
              </div>
              <p className="fine">Для чтения через MCP нужно разрешение «Читать исходники и шаблоны». Отзыв доступа не удалит уже скачанные копии.</p>
            </section>
            {!context.releaseId && (
              <section className="agent-context-section">
                <Button onClick={() => setEdit(!edit)} aria-expanded={edit}>
                  Сохранить эту версию как шаблон
                </Button>
                {edit && (
                  <form
                    className="agent-context-form"
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
                    <p className="fine">
                      Закрепите правила для повторного использования. Шаблон
                      останется на вашей полке; публичная ссылка не создаётся.
                      Правила выпуска неизменяемы — для изменений нужна новая версия
                      работы.
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
              </section>
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
    </Dialog>
  );
}
