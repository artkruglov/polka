import React from "react";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Button } from "../../shared/ui/controls.tsx";

export function TrashArtifactPanel({
  busy,
  error,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog title="Переместить в корзину?" busy={busy} onClose={onClose}>
      <div className="dialog-body">
        <p>
          Все версии и оригиналы сохранятся в корзине. Действующие ссылки будут
          отозваны и не оживут после восстановления.
        </p>
        <p className="fine">
          Работа продолжит занимать место. После восстановления поделиться ею
          можно новой ссылкой.
        </p>
        <ErrorNotice error={error} />
      </div>
      <div className="dialog-footer">
        <Button disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void onConfirm()}>
          В корзину
        </Button>
      </div>
    </Dialog>
  );
}
