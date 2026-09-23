---
name: polka
description: "Save an HTML page, report, prototype or React artifact to Полка (Polka, polochka.app), the user's private shelf, and give the human an unlisted share link. Use when the user asks to save, publish or share an artifact to Полка/Polka («сохрани на Полку», «дай ссылку»), to connect Полка («Подключи Полку: …/connect»), or mentions polochka.app. Covers connecting (the human signs in in the browser; never handle passwords or tokens), polka_publish, links, moderation and how to present the result."
---

# Полка (Polka)

Полка keeps the pages, reports and prototypes the user makes with you and gives an unlisted link to them. Recipients need no account. Works are private on the owner's shelf; only a link lets anyone else see one, and the owner can revoke it.

Installation: https://polochka.app. If the user names another Полка address, use that origin everywhere below. Full reference: https://polochka.app/llms.txt. HTTP API: https://polochka.app/openapi.json.

## 1. Connect (once)

If polka_* tools are available, call polka_context and go to step 2. Otherwise fetch https://polochka.app/connect and follow it. In short:

- Codex CLI: `codex mcp add polka --url https://polochka.app/mcp`
- Claude Code: `claude mcp add --transport http --scope user polka https://polochka.app/mcp`, then ask the user to type /mcp, choose polka, press Authenticate.
- Claude.ai or ChatGPT: ask the user to add a custom connector with URL https://polochka.app/mcp (OAuth).

Tell the user: "Полка will open. Sign in or create a shelf with your email (you get an eight-digit code) and press Allow." The human signs in in the browser. Never ask for their password, email code or a token, and install nothing else.

Without MCP (scripts, CI): the user creates a token at https://polochka.app/settings/agents (client «HTTP API / скрипт») and exports it themselves with `read -r -s POLKA_TOKEN && export POLKA_TOKEN`. Use it only as `Authorization: Bearer $POLKA_TOKEN` from the environment.

## 2. Save and get a link: polka_publish

One call saves the artifact and returns the link:

- `key`: a fresh UUID per artifact; reuse it only to retry the same call.
- `title`: a short human title.
- `html`: ONE self-contained HTML document up to 5 MB: CSS in <style>, images and fonts as data: URIs, no external URLs (the viewer has no network). Convert Markdown or text to semantic HTML first.
- or `component`: a React (JSX/TSX) artifact's source as-is, where the tool description says this installation runs scripts (`componentLanguage: "tsx"` for TypeScript).
- `expiresInDays`: 1, 7 or 30 (default 30).

The tool description states exactly what this installation accepts; follow it. Without MCP, POST the same fields to https://polochka.app/api/v1/publish.

## 3. Share again, revise, revoke

- The link shows the exact revision it was issued for. polka_revise saves a new revision; polka_share (key, artifactId, expectedRevisionId, expiresInDays) issues a link to it.
- polka_revoke_share (shareId) closes a link. polka_list and polka_status never return link secrets.

## 4. Present the result

- Give the returned `url` (https://polochka.app/s#…) as the link. Say the work is saved privately on their shelf and the link is unlisted: only people they send it to can open it, until `expiresAt` or until they revoke it.
- `expiresNote` present: the link was issued for fewer days (new account); say so.
- `url` null: the work is saved privately; `shelfUrl` opens only for the owner and is not a share link. Relay `linkUnavailableReason`.
- `interactiveUnavailableReason` present: say scripts will not run for recipients and why.

## 5. Moderation

A link from a new account, or a page that looks like phishing, may wait for a moderator's review. Then the response has `moderation: "held"` (or `"paused"`) and `moderationMessage`: relay that message and do not present the link as ready. Recipients see a review screen until the link is approved.

## Never

- Ask for, type or store the user's password, email code, OAuth code or token.
- Print a token or Authorization header in chat, logs, commits, tool output or command-line arguments.
- Present a held link as ready, or shelfUrl as a share link.
