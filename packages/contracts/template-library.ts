import { z } from "zod";
import { uuid } from "./index.ts";

export const templateLibraryRole = z.enum(["reader", "curator", "admin"]);

export const createTemplateLibraryInput = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();

export const changeTemplateLibraryRoleInput = z
  .object({ role: templateLibraryRole })
  .strict();

export const createTemplateLibraryInvitationInput = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: templateLibraryRole.default("reader"),
    expiresInHours: z.number().int().min(1).max(168).default(72),
  })
  .strict();

export const acceptTemplateLibraryInvitationInput = z
  .object({ token: z.string().min(32).max(512) })
  .strict();

export const publishTemplateLibraryReleaseInput = z
  .object({ releaseId: uuid })
  .strict();

export const withdrawTemplateLibraryPublicationInput = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

const eventCursor = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine(
    (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
    "Invalid event cursor",
  );

export const listTemplateLibraryEventsInput = z
  .object({
    before: eventCursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type TemplateLibraryRole = z.infer<typeof templateLibraryRole>;
export type TemplateLibrary = {
  id: string;
  name: string;
  role: TemplateLibraryRole;
  createdAt: string;
};
export type TemplateLibraryMember = {
  accountId: string;
  name: string;
  role: TemplateLibraryRole;
  joinedAt: string;
};
export type TemplateLibraryPublication = {
  id: string;
  releaseId: string;
  artifactId: string;
  revisionId: string;
  title: string;
  summary: string;
  publishedAt: string;
};
