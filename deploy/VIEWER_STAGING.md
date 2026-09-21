# Hosted viewer staging candidate — not production

This package is a controlled HTTPS staging shape for the experimental HTML viewer. It is a configuration example and operator runbook, not a certificate installation, cloud deployment, browser acceptance or hosted beta.

Replace the two placeholder names in `viewer-staging.nginx.conf.example` with two operator-controlled HTTPS origins on **different registrable domains**. The viewer domain must be dedicated to this runtime. Unknown hosts and HTTP viewer requests are rejected; the TLS default server rejects unknown SNI before an HTTP request is served, and each known vhost requires both its matching SNI and Host. HTTP app traffic may redirect to HTTPS without carrying a viewer capability. TLS termination belongs at the controlled proxy.

The proxy sends app traffic to `127.0.0.1:4390` and viewer traffic to `127.0.0.1:4391`. The app vhost allows request bodies up to 8 MiB so nginx remains above the application's existing 5 MiB upload and 8 MiB MCP limits; application route limits remain authoritative. The viewer upstream receives the fixed `Host: 127.0.0.1:4391`, while the application receives the fixed app host. Viewer requests do not forward `Cookie` or `Authorization`, and response `Set-Cookie` is hidden. Viewer responses are uncached and access logging is disabled; the sample log format records only request ID, status and method, never URI, query or capability path. Textual nginx error logging is directed to `/dev/null` at `emerg` level from the main context, including pre-vhost/default/app errors: those messages can serialize capability URLs even when viewer access logging is disabled. This deliberately loses textual nginx error diagnostics. Use `nginx -t`, URI-free access status/request IDs, metrics and sanitized application events. Do not temporarily enable raw error logs while serving real capability traffic. Preserve the CSP and no-store/security headers emitted by the application. Do not add CDN HTML injection, SPA fallback, login redirects or a public bucket redirect.

## Application gate

Staging requires the explicit `HTML_LIVE_MODE=staging` configuration implemented by the application. The absent/default path remains off. Remove the legacy `HTML_LIVE_ENABLED` setting when selecting staging; do not combine the two switches. Use canonical public HTTPS `APP_ORIGIN` and `VIEWER_ORIGIN` with no credentials, path, query or fragment; the origins must be different registrable domains and `COOKIE_SECURE=true`. Internal listeners remain loopback (`HOST=127.0.0.1`, `PORT=4390`, `VIEWER_HOST=127.0.0.1`, `VIEWER_PORT=4391`).

Set `HTML_LIVE_STAGING_REVISION_IDS` to at most 100 distinct, immutable revision UUIDs. It must be non-empty for a staging run. Keep the list in a protected operator environment file and do not put capability tokens or user data in it. This allowlist is a bounded experiment gate, not a publication or production readiness signal.

## Controlled procedure

1. Prepare the two domains, certificates, loopback upstreams and a protected environment file. Verify the proxy rejects unknown hosts and HTTP viewer requests before using any real test account.
2. Start the existing loopback app/viewer processes with the explicit staging gate and the bounded revision UUID list. This example assumes the existing Node listeners; the base self-host container shape is not compatible with this loopback-only staging recipe unless an operator deliberately supplies that host deployment.
3. Use only synthetic or approved staging revisions. Verify owner and recipient grants, expiry and revoke through the app. Confirm that the viewer response has no cookie-setting header and that proxy logs contain no capability path, query or referer.
4. Run the browser acceptance separately: TLS chain, cross-site iframe, mobile/desktop layout, grant expiry/revoke, navigation, storage, popup, form, resource and egress probes. A blocked render or a missing positive network control is inconclusive; do not call it no-egress proof.
5. To stop the experiment, stop the running processes, set `HTML_LIVE_MODE=disabled`, remove `HTML_LIVE_ENABLED` and `HTML_LIVE_STAGING_REVISION_IDS`, and restart with that configuration. Editing an environment file alone does not affect running processes. New requests to existing grants must be rejected after restart; already delivered bytes cannot be recalled. Static preview and download paths remain separate.

The current contract does not prove CPU limits, browser egress isolation, WebRTC/DNS behavior, third-party-cookie behavior or real TLS/browser compatibility. No public production enablement, hosted beta, cloud rollout or certificate/domain installation is claimed here.

The runtime currently serves CSP from the app/viewer code. Keep `sandbox="allow-scripts"`, viewer `frame-ancestors` and the exact grant checks unchanged; this proxy cannot replace browser isolation or server authorization.


## Repeatable local proxy smoke

Run `python3 scripts/test-viewer-proxy.py --confirm-synthetic` from the repository. It requires the already cached pinned nginx image, host Python/OpenSSL and Docker; it never pulls images, publishes ports, connects to a database or changes the trust store. The test snapshots this proxy configuration and mounts temporary certificates in a network-none container with two synthetic upstreams. It checks14 routing, TLS, header, body-limit and log cases and removes its exact container and temporary directory. The pinned image is the verified local ARM64 image; another operator must explicitly validate a suitable image before changing that test pin.

[Local results](../docs/reviews/2026-09-21-viewer-staging/proxy-result.json) prove these synthetic proxy cases only. Browser, real-domain and cloud acceptance remain separate.
