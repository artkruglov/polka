import React from "react";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import { Button } from "../../shared/ui/controls.tsx";

export function TrashArtifactPanel({
  title,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  /** The work's title, when the dialog opens away from the work (a shelf card). */
  title?: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog
      title={title ? `Переместить «${title}» в корзину?` : "Переместить в корзину?"}
      busy={busy}
      onClose={onClose}
    >
      <div className="dialog-body">
        <p>
          Все версии и оригиналы сохранятся в корзине. Действующие ссылки будут отозваны и не оживут после
          восстановления.
        </p>
        <p className="fine">Работа продолжит занимать место. После восстановления поделиться ею можно новой ссылкой.</p>
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
