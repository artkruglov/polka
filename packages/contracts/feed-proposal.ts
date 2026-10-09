import { z } from "zod";
import { uuid } from "./index.ts";

/**
 * A curator's proposal of one version of a department shelf's work to «Лента»
 * (docs/specs/DISCOVER_V2.md, «Предложение с полки отдела»). The operator
 * decides; nothing is published by the proposal itself.
 */
export const createFeedProposalInput = z
  .object({
    revisionId: uuid,
    title: z.string().trim().min(1, "Назовите материал.").max(120, "Название — до 120 символов."),
    summary: z.string().trim().min(1, "Одной строкой: что узнает читатель.").max(200, "Описание — до 200 символов."),
    // The two confirmations of DISCOVER_V2 §5: the shelf may show it, and it
    // names no one's personal data.
    rights: z.literal(true, { message: "Подтвердите, что отдел может показывать эту работу." }),
    noPersonalData: z.literal(true, {
      message: "Подтвердите, что в работе нет чужих персональных данных.",
    }),
  })
  .strict();

export const FEED_PROPOSAL_STATES = ["pending", "published", "rejected", "withdrawn"] as const;
export type FeedProposalState = (typeof FEED_PROPOSAL_STATES)[number];

export type FeedProposal = {
  id: string;
  revisionId: string;
  revisionNumber: number;
  title: string;
  summary: string;
  state: FeedProposalState;
  /** The operator's reason for «нужны правки» or «не подходит». */
  reason: string | null;
  proposedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
};
