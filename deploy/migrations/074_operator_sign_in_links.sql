-- One-time sign-in links the operator prints on the server
-- (npm run admin -- account bootstrap <email>, deploy/hosted/README.md):
-- the first administrator of a new installation signs in without mail or an
-- identity provider, and an operator can let a person back in the same way.
--
-- operator_sign_in_links  one row per printed link: SHA-256 of the token
--                         (the token itself is never stored), the account it
--                         opens, one use within at most a day (the command
--                         uses an hour). Issuing a new link spends the
--                         account's older ones. Maintenance deletes rows a
--                         day after they expire; they go with the account
--                         row (ON DELETE CASCADE).
CREATE TABLE operator_sign_in_links (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 day')
);
CREATE INDEX operator_sign_in_links_account ON operator_sign_in_links(account_id);
CREATE INDEX operator_sign_in_links_expiry ON operator_sign_in_links(expires_at);
