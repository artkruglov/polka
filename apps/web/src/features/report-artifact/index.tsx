import React, { useState, useRef } from "react";
import { Flag } from "lucide-react";
import { client } from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Button, TextAreaField, SelectField } from "../../shared/ui/controls.tsx";
import {
  REPORT_REASONS,
  type ReportReason,
} from "../../../../../packages/contracts/constants.ts";

const reasonLabel: Record<ReportReason, string> = {
  phishing: "Фишинг или обман",
  malware: "Вредоносное содержимое",
  personal_data: "Чужие личные данные",
  illegal: "Незаконное содержимое",
  other: "Другое",
  child_sexual: "Сексуальное с участием детей",
  intimate_nonconsensual: "Интимное без согласия",
  threat_to_life: "Угроза жизни",
};
export function ReportArtifactPanel({
  token,
  onClose,
  onSent,
  commentId,
}: {
  token: string;
  onClose: () => void;
  onSent: () => void;
  /** A report about one comment of the link, not about the page. */
  commentId?: string;
}) {
  const sending = useRef(false);
  // One key per report: a retry after a lost response must not file a second
  // one. Editing the report starts a new key, since the server rejects a key
  // reused for different content.
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const [reportReason, setReportReason] = useState<ReportReason>("other");
  const [reportComment, setReportComment] = useState("");
  const [reportError, setReportError] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  return (
    <Dialog
      title={commentId ? "Пожаловаться на комментарий" : "Пожаловаться на работу"}
      onClose={() => !reportBusy && onClose()}
      busy={reportBusy}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (sending.current) return;
          sending.current = true;
          setReportBusy(true);
          setReportError("");
          try {
            const payload = JSON.stringify([reportReason, reportComment.trim()]);
            if (attempt.current?.payload !== payload)
              attempt.current = { key: crypto.randomUUID(), payload };
            await client.report(
              token,
              reportReason,
              reportComment,
              attempt.current.key,
              commentId,
            );
            onSent();
            onClose();
          } catch (e) {
            setReportError(
              e instanceof Error
                ? e.message
                : "Не удалось отправить жалобу. Повторите позже.",
            );
          } finally {
            sending.current = false;
            setReportBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <p>
            {commentId
              ? "Жалоба на комментарий уйдёт модератору Полки. Автор комментария не узнает, кто пожаловался."
              : "Жалоба привязана к этой ссылке и версии. Владелец не увидит ваши личные данные."}
          </p>
          <SelectField
            label="Причина"
            disabled={reportBusy}
            value={reportReason}
            onChange={(event) =>
              setReportReason(event.target.value as ReportReason)
            }
          >
            {REPORT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reasonLabel[reason]}
              </option>
            ))}
          </SelectField>
          <TextAreaField
            label="Комментарий (необязательно)"
            value={reportComment}
            onChange={(event) => setReportComment(event.target.value)}
            maxLength={1000}
            rows={4}
            placeholder="Что нужно проверить?"
          />
          <ErrorNotice error={reportError} />
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={reportBusy} onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" type="submit" disabled={reportBusy}>
            <Flag /> Отправить жалобу
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
