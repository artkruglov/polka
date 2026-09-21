import React, { useState, useRef } from "react";
import { Flag } from "lucide-react";
import { client } from "../../shared/api/client.ts";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Button, TextAreaField, SelectField } from "../../shared/ui/controls.tsx";
export function ReportArtifactPanel({
  token,
  onClose,
  onSent,
}: {
  token: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const sending = useRef(false);
  const [reportReason, setReportReason] = useState<
    "phishing" | "malware" | "personal_data" | "illegal" | "other"
  >("other");
  const [reportComment, setReportComment] = useState("");
  const [reportError, setReportError] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  return (
    <Dialog
      title="Пожаловаться на работу"
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
            await client.report(token, reportReason, reportComment);
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
            Жалоба привязана к этой ссылке и версии. Владелец не увидит ваши
            личные данные.
          </p>
          <SelectField
            label="Причина"
            disabled={reportBusy}
            value={reportReason}
            onChange={(event) =>
              setReportReason(event.target.value as typeof reportReason)
            }
          >
            <option value="phishing">Фишинг или обман</option>
            <option value="malware">Вредоносное содержимое</option>
            <option value="personal_data">Чужие личные данные</option>
            <option value="illegal">Незаконное содержимое</option>
            <option value="other">Другое</option>
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
