import React from "react";
import { Upload } from "lucide-react";
import { Dialog } from "../../shared/ui/index.tsx";
import { Button } from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";

export function ReworkArtifactPanel({
  title,
  onClose,
  onUpload,
}: {
  title: string;
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
          value={`Возьми мою работу «${title}» с Полки. Измени её: [опишите, что поменять]. Сохрани результат на Полке новой версией этой же работы.`}
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
