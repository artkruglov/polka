# Local bundle runtime evidence

The bundle runtime remains restricted to the existing loopback-only
`HTML_LIVE_ENABLED` experiment. The source bundle and owner export stay
unchanged; runtime HTML is stored as a separate, revision-bound derivative.

## Verification

```sh
npm test
```

Result on 2026-09-20: 58 passed, 0 failed.

```sh
npm run test:runtime
```

Result on 2026-09-20: 3 passed, 0 failed. The integration suite covers tenant
isolation, parallel idempotency, separate derivative quota and pending limits,
unsupported builds, exact export preservation, immutable S3 retry, expired
orphan cleanup, derivative pinning across share publication, revocation,
expiry, and the disabled runtime gate.

```sh
npm run check
git diff --check
```

Both checks passed after the runtime implementation.

## Independent root verification

Real local HTTP upload/finalize/build/status/share returned ready for the
four-file team-report fixture. Original export was checked byte-for-byte before
and after building; retry returned the same receipt. Local receipt is kept in
`.local/bundle-runtime-fixture.json` (not a public release artifact).

`npm run test:live`: 7 passed, 0 failed. Luna's pending recovery now offers an
explicit resume POST; TypeScript and frontend build passed. Browser interaction
with this uploaded bundle, mobile acceptance and hosted isolation remain open.

## Browser findings (before acceptance)

Actual recipient testing found two defects despite green backend tests:
- Preview returned the fallback for every bundle grant, hiding live launch.
- Newly inserted parse5 text nodes lacked parentNode; serialization escaped JS
  arrow syntax, resulting in browser SyntaxError and non-working interaction.

Both require correction and a fresh runtime derivative. Original files/export
remain unchanged. Do not count the initial ready response as working runtime.

## Browser retest after fixes

Builder bundle-inline-v2 attaches parentNode to generated script/style text.
Regression preserves arrow syntax and compile-checks the original fixture script.
A fresh uploaded four-file report was built and exported exactly before/after.
In Codex in-app browser, an unauthenticated recipient explicitly launched it:
CSS and SVG appeared; button changed 12/8 → 9/11 → 12/8. At viewport390,
clientWidth=scrollWidth=innerWidth=390; cards stacked and interaction worked.
The screenshot capture scaled unusually, so no claim of pixel-perfect mobile
review. Revoking the synthetic share via owner HTTP returned200; recipient
«Обновить доступ» then showed «Работа по этой ссылке недоступна».

This accepts one local bundle scenario, not hosted isolation or all HTML.
Already loaded bytes cannot be recalled. Existing v1 derivatives are not rewritten;
current builder validation requires a new v2 preparation/share.
