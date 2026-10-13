import React from "react";
import type { CapabilitiesState } from "../../entities/capabilities/useCapabilities.ts";
import { onCloud } from "../../shared/lib/project-links.ts";

export type LegalDoc = "privacy" | "terms" | "bot";

export const LEGAL_TITLES: Record<Exclude<LegalDoc, "bot">, string> = {
  privacy: "Политика обработки персональных данных",
  terms: "Пользовательское соглашение",
};

/**
 * What /privacy and /terms show here. privacy.md and terms.md are the
 * cloud's documents (polochka.app): another installation never shows them.
 * Its operator either names their own (PRIVACY_URL, TERMS_URL) or the page
 * says who runs the installation and how to reach them.
 */
export type LegalView =
  | { kind: "text" }
  | { kind: "redirect"; url: string }
  | { kind: "operator"; operatorName: string | null; contact: string | null }
  | { kind: "loading" };

export function legalView(doc: LegalDoc, state: CapabilitiesState, cloud = onCloud()): LegalView {
  if (doc === "bot") return { kind: "text" };
  if (state.status !== "ready") {
    // polochka.app shows its texts at once, as it always did; elsewhere wait
    // for the installation's answer rather than flash the cloud's documents.
    if (cloud) return { kind: "text" };
    return state.status === "loading" ? { kind: "loading" } : { kind: "operator", operatorName: null, contact: null };
  }
  const { legal, privacyContact } = state.capabilities;
  const url = doc === "privacy" ? legal.privacyUrl : legal.termsUrl;
  if (url) return { kind: "redirect", url };
  if (legal.cloud) return { kind: "text" };
  return { kind: "operator", operatorName: legal.operatorName, contact: privacyContact };
}

/** The page of an installation that is not the cloud, in place of the cloud's document. */
export function OperatorDocument({
  doc,
  operatorName,
  contact,
}: {
  doc: Exclude<LegalDoc, "bot">;
  operatorName: string | null;
  contact: string | null;
}) {
  return (
    <>
      <h1>{LEGAL_TITLES[doc]}</h1>
      <p>
        Эта установка Полки принадлежит {operatorName ?? "организации, которая её развернула"}. Политику обработки
        персональных данных и условия использования публикует она.
      </p>
      {contact && (
        <p>
          Вопросы о данных и об условиях: <a href={`mailto:${contact}`}>{contact}</a>.
        </p>
      )}
    </>
  );
}

/** PRIVACY_URL or TERMS_URL: the route leads there; this shows while it does. */
export function OperatorLink({ doc, url }: { doc: Exclude<LegalDoc, "bot">; url: string }) {
  return (
    <>
      <h1>{LEGAL_TITLES[doc]}</h1>
      <p>
        Документ опубликован на сайте владельца этой установки: <a href={url}>{url}</a>.
      </p>
    </>
  );
}
