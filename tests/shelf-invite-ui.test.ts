// The invitation links on a department shelf's members dialog and the page
// that accepts one (docs/specs/TEAM_SHELVES.md, «Приглашение ссылкой»).
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InviteLinksView,
  invitationSummary,
  inviteRoles,
} from "../apps/web/src/features/shelf-members/InviteLinks.tsx";
import {
  parseShelfInvitation,
  parseShelfInvitationFragment,
} from "../apps/web/src/shared/lib/shelf-invite.ts";
import { isAppPage } from "../packages/contracts/app-routes.ts";
import { routeTitle } from "../apps/web/src/app/routing/titles.ts";
import type { ShelfInvitation } from "../apps/web/src/shared/api/client.ts";

const me = "11111111-1111-4111-8111-111111111111";
const colleague = "22222222-2222-4222-8222-222222222222";
const link = (patch: Partial<ShelfInvitation>): ShelfInvitation => ({
  id: "33333333-3333-4333-8333-333333333333",
  role: "author",
  maxUses: 1,
  uses: 0,
  status: "active",
  createdAt: "2026-10-08T09:00:00.000Z",
  expiresAt: "2026-10-11T09:00:00.000Z",
  invitedBy: me,
  inviterName: "Анна",
  ...patch,
});

const render = (props: Partial<React.ComponentProps<typeof InviteLinksView>>) =>
  renderToStaticMarkup(
    React.createElement(InviteLinksView, {
      inviter: "admin",
      accountId: me,
      items: [],
      created: null,
      busy: false,
      error: "",
      onCreate: () => {},
      onRevoke: () => {},
      ...props,
    }),
  );

test("the admin offers every role but admin; a curator, readers and authors", () => {
  assert.deepEqual(inviteRoles("admin"), ["reader", "author", "curator"]);
  assert.deepEqual(inviteRoles("curator"), ["reader", "author"]);
  const admin = render({ inviter: "admin" });
  assert.match(admin, /Пригласить ссылкой/);
  assert.match(admin, /ещё ни разу не входил/);
  assert.match(admin, /<option value="curator">Куратор/);
  assert.doesNotMatch(admin, /value="admin"/);
  assert.match(admin, /Создать ссылку/);
  for (const text of ["сутки", "3 дня", "неделю", "один человек", "до 50 человек"]) assert.match(admin, new RegExp(text));
  const curator = render({ inviter: "curator" });
  assert.doesNotMatch(curator, /<option value="curator">/);
  assert.match(curator, /Кураторов приглашает администратор/);
});

test("a new link is shown once, with a copy button", () => {
  const html = render({
    created: { id: "x", url: "https://polka.test/shelf-invite#token=abc&shelfId=def", summary: "автор · для одного · до 11 октября" },
  });
  assert.match(html, /второй раз Полка её не покажет/);
  assert.match(html, /https:\/\/polka.test\/shelf-invite#token=abc&amp;shelfId=def/);
  assert.match(html, /Скопировать ссылку/);
});

test("active links are listed; a curator revokes only its own", () => {
  const items = [
    link({}),
    link({ id: "44444444-4444-4444-8444-444444444444", invitedBy: colleague, inviterName: "Борис", role: "reader", maxUses: 10, uses: 3 }),
    link({ id: "55555555-5555-4555-8555-555555555555", status: "used", uses: 1 }),
  ];
  const admin = render({ items });
  assert.equal(admin.match(/Отозвать/g)?.length, 2);
  assert.match(admin, /пришли 3 из 10/);
  assert.match(admin, /создал Борис/);
  const curator = render({ inviter: "curator", items });
  assert.equal(curator.match(/Отозвать/g)?.length, 1);
  assert.match(render({ items: null }), /Загружаем приглашения/);
  assert.equal(invitationSummary(link({ status: "expired" })), "автор · для одного · срок истёк");
  assert.equal(invitationSummary(link({ status: "revoked", role: "curator" })), "куратор · для одного · отозвана");
});

test("the page reads the link from its fragment and is a known route", () => {
  const token = "a".repeat(43);
  const shelfId = "66666666-6666-4666-8666-666666666666";
  assert.deepEqual(parseShelfInvitationFragment(`#token=${token}&shelfId=${shelfId}`), { token, shelfId });
  assert.equal(parseShelfInvitationFragment(`#token=short&shelfId=${shelfId}`), null);
  assert.equal(parseShelfInvitation(token, "not-a-shelf"), null);
  assert.equal(parseShelfInvitationFragment("#%"), null);
  assert.ok(isAppPage("/shelf-invite"));
  assert.equal(routeTitle("/shelf-invite"), "Приглашение на полку отдела");
});
