# MCP CLI token foundation evidence

This slice implements owner-managed CLI credentials and the shared service
actor boundary. It does not add the MCP transport or tools and does not claim
OAuth or client compatibility.

The database stores only SHA-256 token hashes. Issued bearer and CSRF values
were kept out of test output, logs, audit rows, and this evidence file.

## Verification

```sh
npm run test:service-auth
```

Result on 2026-09-20: 4 passed, 0 failed. Coverage includes session-bound
CSRF, the scope allowlist, exact endpoint audience, default and maximum TTL,
tenant isolation, disabled accounts, expiry, revocation, and transactional
actor rechecks after revoke. It also proves that bounded inactive history never
hides an older active credential from the owner.

```sh
npm test
```

Result after migration 009: 58 passed, 0 failed.

```sh
npm run check
git diff --check
```

Both checks passed.
