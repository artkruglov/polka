// Zod-free copies of contract constants for the browser's initial chunk.
// index.ts pulls in zod; tests/unit.test.ts keeps both definitions equal.
export const MAX_BYTES = 5 * 1024 * 1024;
/** Longest stored title; every path that names a work uses this one limit. */
export const MAX_TITLE = 160;
export const MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/html",
] as const;
export type UploadMime = (typeof MIME)[number];
/** Whether text is an HTML page rather than prose; the server refuses text/html without it. */
export const looksLikeHtml = (source: string) =>
  /<(?:!doctype\s+html|html|head|body|main|div|p|h[1-6]|table|section|article|ul|ol|style)\b/i.test(
    source,
  );
export const REPORT_REASONS = [
  "phishing",
  "malware",
  "personal_data",
  "illegal",
  "other",
  "child_sexual",
  "intimate_nonconsensual",
  "threat_to_life",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** A single report of one of these pauses the link at once. */
export const URGENT_REPORT_REASONS: readonly ReportReason[] = [
  "child_sexual",
  "intimate_nonconsensual",
  "threat_to_life",
];
export const AGENT_SCOPES = [
  "context",
  "read",
  "source:read",
  "capture",
  "revise",
  "share",
  "manage",
] as const;
/** «Для компаний» (/enterprise): the request form's choices and limits. */
export const ENTERPRISE_TEAM_SIZES = [
  "1-10",
  "11-50",
  "51-200",
  "201-1000",
  "1000+",
] as const;
export type EnterpriseTeamSize = (typeof ENTERPRISE_TEAM_SIZES)[number];
export const ENTERPRISE_INTERESTS = [
  "cloud",
  "self-hosted",
  "commercial-license",
  "other",
] as const;
export type EnterpriseInterest = (typeof ENTERPRISE_INTERESTS)[number];
export const ENTERPRISE_LIMITS = {
  name: 100,
  company: 200,
  email: 254,
  comment: 2000,
} as const;
