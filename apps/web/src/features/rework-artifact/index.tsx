import React from "react";
import { Upload } from "lucide-react";
import { Dialog } from "../../shared/ui/index.tsx";
import { Button } from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import { updatePhrase } from "../../entities/artifact/agent-phrases.ts";

export function ReworkArtifactPanel({
  title,
  shelfUrl,
  onClose,
  onUpload,
}: {
  title: string;
  /** The work's page, named in the phrase so the agent finds it. */
  shelfUrl: string;
  onClose: () => void;
  onUpload: () => void;
}) {
  return (
    <Dialog title="Переработать с помощью агента" onClose={onClose}>
      <div className="dialog-body">
        <p>
          Передайте работу своему агенту и опишите изменения. Сохраните
          результат новой версией — отправленная ссылка останется прежней.
        </p>
        <CopyText
          label="Текст запроса агенту"
          value={`${updatePhrase(title, shelfUrl)} Что поменять: [опишите]. Сохрани результат новой версией этой же работы.`}
          buttonVariant="primary"
        />
        <p className="fine">
          <a href="/settings/agents">Подключить агента через MCP</a>. Если агент
          не подключён, скачайте оригинал и приложите к сообщению.
        </p>
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose}>Закрыть</Button>
        <Button variant="primary" onClick={onUpload}>
          <Upload />
          Загрузить новую версию
        </Button>
      </div>
    </Dialog>
  );
}
