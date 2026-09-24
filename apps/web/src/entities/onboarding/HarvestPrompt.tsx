import React from "react";
import { Segmented } from "../../shared/ui/controls.tsx";
import { CopyText } from "../../shared/ui/CopyText.tsx";
import {
  harvestClients,
  harvestPrompt,
  type HarvestClientId,
} from "./agent-setup.ts";

/**
 * «Скопировать задание агенту»: the harvest task for one client, with tabs
 * to switch. Used by the first-run steps and the agents page once connected.
 */
export function HarvestPrompt({
  client,
  onClient,
  primary = true,
}: {
  client: HarvestClientId;
  onClient: (id: HarvestClientId) => void;
  /** The step this belongs to is the current one. */
  primary?: boolean;
}) {
  return (
    <div className="harvest-prompt">
      <Segmented
        label="Где вы работаете с ИИ"
        value={client}
        onChange={onClient}
        options={harvestClients.map((item) => ({
          id: item.id,
          label: item.name,
        }))}
      />
      <CopyText
        key={client}
        label="Задание агенту"
        value={harvestPrompt(client)}
        rows={6}
        buttonLabel="Скопировать задание агенту"
        successText="Задание скопировано. Вставьте его в чат агента"
        buttonVariant={primary ? "primary" : "secondary"}
      />
    </div>
  );
}
