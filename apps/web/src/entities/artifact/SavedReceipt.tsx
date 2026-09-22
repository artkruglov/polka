import React from "react";
import { ArrowUpRight, Check } from "lucide-react";
import type { Receipt } from "../../../../../packages/contracts/index.ts";
import { Button, LinkButton, Notice } from "../../shared/ui/controls.tsx";

/** The save succeeded but the saved work could not be read back: keep the receipt visible. */
export function SavedReceipt({
  receipt,
  error,
  busy,
  onShow,
  onRestart,
  restartLabel,
}: {
  receipt: Receipt;
  error: string;
  busy: boolean;
  onShow: () => void;
  onRestart: () => void;
  restartLabel: string;
}) {
  return (
    <div className="bring-result">
      <span className="result-kicker ok">
        <Check /> Сохранено на полке · версия {receipt.number}
      </span>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="bring-actions">
        <Button variant="primary" busy={busy} onClick={onShow}>
          Показать результат
        </Button>
        <LinkButton href={`/works/${receipt.artifactId}`}>
          Открыть на полке <ArrowUpRight />
        </LinkButton>
        <Button variant="quiet" onClick={onRestart} disabled={busy}>
          {restartLabel}
        </Button>
      </div>
    </div>
  );
}
