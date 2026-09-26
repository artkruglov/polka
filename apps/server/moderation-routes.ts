// One-click moderation from the operator's mail (docs/specs/ABUSE_PROTECTION.md,
// section 5). The page /moderation#<token> is the SPA: opening it changes
// nothing. It asks /inspect what the token would do (read-only), may show a
// preview grant, and only /act performs the action. All three are POST with
// the token in the body, so it never lands in a URL, and the app's Origin
// check applies. Every action is idempotent.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { limitAttempts } from "./auth.ts";
import { db, transaction } from "./db.ts";
import { Problem, missing } from "./errors.ts";
import {
  ModerationError,
  approveShareAsOperator,
  blockShareAsOperator,
  clean,
  closeAndDisableAsOperator,
  closeShareAsOperator,
  unpauseShareAsOperator,
  type OperatorOutcome,
} from "./moderation.ts";
import { ACTION_LABEL, csamSignal } from "./moderation-mail.ts";
import { modelView } from "./content-moderation.ts";
import {
  SEVERE,
  describeFindings,
  findingsOf,
} from "./content-filter/policy.ts";
import {
  verifyModerationToken,
  type ModerationAction,
  type ModerationToken,
} from "./moderation-tokens.ts";
import { describeSignals } from "./phishing-signals.ts";
import { issueShareGrant } from "./share-grants.ts";
import { authorStanding, SIGNED_UP_SQL } from "./share-moderation.ts";

const body = z
  .object({
    token: z.string().max(600),
    // «Заблокировать»: keep the objects as evidence (legal hold), with the
    // request it answers. Set on the confirmation page before the block.
    legalHold: z.boolean().optional(),
    authority: z.string().trim().max(500).optional(),
  })
  .strict();

const refused = () =>
  new Problem(
    403,
    "forbidden",
    "Ссылка из письма недействительна или устарела: кнопки действуют 7 дней. Откройте более свежее письмо или используйте скрипты модерации.",
  );

const EFFECT: Record<ModerationAction, string> = {
  preview: "Только просмотр: ничего не меняется.",
  approve:
    "Получатели увидят работу по этой ссылке. Жалобы на ссылку будут отмечены рассмотренными.",
  "approve-trust":
    "Получатели увидят работу по этой ссылке, а автор станет доверенным: его следующие ссылки открываются без проверки.",
  unpause:
    "Пауза снимется: получатели снова увидят работу. Жалобы будут отмечены рассмотренными.",
  close:
    "Ссылка закроется навсегда. Работа останется на полке автора, новую ссылку он сможет создать сам.",
  "close-disable":
    "Эта и все остальные ссылки автора закроются, вход и подключения агентов будут отключены. Данные не удаляются; вернуть доступ можно скриптом moderation:enable.",
  block:
    "Работа будет заблокирована: получатели увидят «Ссылка недоступна», автор не сможет отправить её заново. Содержимое удаляется из хранилища (сразу или по истечении срока хранения доказательств), если не отметить «Сохранить как доказательство». Снять блокировку — moderation:unblock.",
};

const REPORT_REASON: Record<string, string> = {
  phishing: "Фишинг или выдаёт себя за другого",
  malware: "Вредоносное содержимое",
  personal_data: "Чужие персональные данные",
  illegal: "Незаконное содержимое",
  child_sexual: "Сексуальное с участием детей",
  intimate_nonconsensual: "Интимное без согласия",
  threat_to_life: "Угроза жизни",
  other: "Другое",
};

async function verified(req: { body: unknown; ip: string }) {
  await limitAttempts(`moderation:ip:${req.ip}`, 120);
  const parsed = body.safeParse(req.body);
  const token = parsed.success ? verifyModerationToken(parsed.data.token) : null;
  if (!token) throw refused();
  return token;
}

const blockOptions = (req: { body: unknown }) => {
  const parsed = body.safeParse(req.body);
  return parsed.success
    ? { legalHold: parsed.data.legalHold === true, authority: parsed.data.authority || null }
    : { legalHold: false, authority: null };
};

/** What the confirmation page shows. Reads only. */
async function describe(token: ModerationToken) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT share.id,share.tenant_id,share.moderation,share.moderation_reason,share.created_by,
       (NOT share.revoked AND share.expires_at>now()) AS live,share.expires_at,
       artifact.title,revision.mime,revision.html_profile,revision.number,
       revision.phishing_signals,revision.content_filter,
       account.name,account.email,account.disabled,
       ${SIGNED_UP_SQL("account")} AS signed_up
     FROM shares share
     JOIN artifacts artifact ON artifact.id=share.artifact_id
     JOIN revisions revision ON revision.id=share.revision_id
     JOIN tenants tenant ON tenant.id=share.tenant_id
     JOIN accounts account ON account.id=COALESCE(tenant.owner_id,share.created_by)
     WHERE share.id=$1`,
    [token.shareId],
  );
  if (!row) throw missing();
  const standing = await authorStanding(db, row.tenant_id, row.created_by);
  const csam = csamSignal(undefined, row);
  const findings = findingsOf(row.content_filter, modelView(row.content_filter));
  const { rows: reports } = await db.query(
    `SELECT reason,comment,status,created_at FROM share_reports
     WHERE share_id=$1 ORDER BY created_at DESC LIMIT 10`,
    [token.shareId],
  );
  return {
    action: token.action,
    actionLabel: ACTION_LABEL[token.action],
    effect: EFFECT[token.action],
    tokenExpiresAt: token.expiresAt.toISOString(),
    share: {
      id: row.id as string,
      // A CSAM signal: nothing of the work is shown, the operator included.
      title: csam ? "Скрыто: сигнал CSAM" : clean(row.title, 160) || "Без названия",
      csam,
      mime: row.mime as string,
      htmlProfile: row.html_profile as string | null,
      version: row.number as number,
      state: row.live ? (row.moderation as string) : "closed",
      reason: row.moderation_reason as string | null,
      signals: describeSignals(row.phishing_signals ?? []) || null,
      content: findings.length ? describeFindings(findings) : null,
    },
    author: {
      // An operator-created login is named; a signed-up account is its email.
      label: row.signed_up
        ? clean(row.email ?? "адрес не указан", 160)
        : `${clean(row.name, 60)}${row.email ? ` <${clean(row.email, 160)}>` : ""}`,
      operatorCreated: standing.operatorCreated,
      createdAt: standing.createdAt?.toISOString() ?? null,
      trusted: standing.trusted,
      disabled: row.disabled as boolean,
    },
    reports: reports.map((report) => ({
      reason: REPORT_REASON[report.reason] ?? report.reason,
      comment: report.comment ? clean(report.comment, 1000) : null,
      settled: report.status !== "new",
      createdAt: new Date(report.created_at).toISOString(),
    })),
  };
}

async function perform(
  token: ModerationToken,
  options: { legalHold: boolean; authority: string | null },
): Promise<OperatorOutcome> {
  switch (token.action) {
    case "approve":
      return approveShareAsOperator(token.shareId, false, "operator-mail");
    case "approve-trust":
      return approveShareAsOperator(token.shareId, true, "operator-mail");
    case "unpause":
      return unpauseShareAsOperator(token.shareId, "operator-mail");
    case "close":
      return closeShareAsOperator(token.shareId, "operator-mail");
    case "close-disable":
      return closeAndDisableAsOperator(token.shareId, "operator-mail");
    case "block": {
      const category = await blockCategory(token.shareId);
      return blockShareAsOperator(token.shareId, {
        actor: "operator-mail",
        reason: "решение оператора по письму модерации",
        category,
        authority: options.authority,
        legalHold: options.legalHold
          ? options.authority || "решение оператора: сохранить как доказательство"
          : null,
      });
    }
    case "preview":
      throw new Problem(
        400,
        "invalid",
        "Эта ссылка только для просмотра; действие выберите кнопкой в письме.",
      );
  }
}

/** The strongest category the filter found for the link's revision. */
async function blockCategory(shareId: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT revision.content_filter FROM shares share
     JOIN revisions revision ON revision.id=share.revision_id WHERE share.id=$1`,
    [shareId],
  );
  const findings = findingsOf(row?.content_filter, modelView(row?.content_filter)).sort((a, b) => Number(SEVERE.has(b.category)) - Number(SEVERE.has(a.category)) || b.score - a.score);
  return findings[0]?.category ?? "other";
}

/**
 * A 60-second grant for the operator, whatever the link's moderation state;
 * never for a CSAM signal or a blocked link (its content may be deleted).
 */
async function preview(token: ModerationToken) {
  const {
    rows: [flagged],
  } = await db.query(
    `SELECT share.moderation,share.moderation_reason,revision.content_filter
     FROM shares share JOIN revisions revision ON revision.id=share.revision_id
     WHERE share.id=$1`,
    [token.shareId],
  );
  if (flagged && (csamSignal(undefined, flagged) || flagged.moderation === "blocked"))
    throw new Problem(
      403,
      "forbidden",
      flagged.moderation === "blocked"
        ? "Ссылка заблокирована: просмотра нет."
        : "Сработал признак CSAM: содержимое не показывается никому, в том числе модератору.",
    );
  return transaction(async (c) => {
    const {
      rows: [share],
    } = await c.query(
      `SELECT share.*,artifact.title FROM shares share
       JOIN artifacts artifact ON artifact.id=share.artifact_id
         AND artifact.tenant_id=share.tenant_id AND artifact.trashed_at IS NULL
       JOIN tenants tenant ON tenant.id=share.tenant_id
       JOIN accounts account ON account.id=COALESCE(tenant.owner_id,share.created_by)
       WHERE share.id=$1 AND NOT share.revoked AND share.expires_at>now()
         AND NOT account.disabled AND account.deletion_requested_at IS NULL
       FOR SHARE OF share`,
      [token.shareId],
    );
    if (!share)
      throw new Problem(
        404,
        "not_found",
        "Ссылка уже закрыта, истекла или автор отключён: просмотра нет.",
      );
    const view = await issueShareGrant(c, share, share.artifact_id);
    return {
      title: share.title ?? "Работа",
      ...view,
      publisher: "user" as const,
      authorIsNew: false,
    };
  });
}

export function registerModerationRoutes(app: FastifyInstance) {
  app.post("/api/moderation/inspect", { bodyLimit: 2048 }, async (req) =>
    describe(await verified(req)),
  );
  app.post("/api/moderation/preview", { bodyLimit: 2048 }, async (req) =>
    preview(await verified(req)),
  );
  app.post("/api/moderation/act", { bodyLimit: 2048 }, async (req) => {
    const token = await verified(req);
    try {
      const outcome = await perform(token, blockOptions(req));
      console.info(
        JSON.stringify({
          event: "moderation.action",
          action: token.action,
          shareId: token.shareId,
          changed: outcome.changed,
        }),
      );
      return { action: token.action, ...outcome };
    } catch (error) {
      if (error instanceof ModerationError) throw missing();
      throw error;
    }
  });
}
