ALTER TABLE accounts ADD COLUMN email text UNIQUE;
ALTER TABLE accounts ADD COLUMN email_verified_at timestamptz;
ALTER TABLE accounts ADD COLUMN display_name text;
CREATE TABLE login_challenges (
 id uuid PRIMARY KEY,
 email text NOT NULL,
 code_hash text NOT NULL,
 browser_hash text NOT NULL,
 delivery text NOT NULL CHECK(delivery IN ('local','smtp')),
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_challenges_expiry ON login_challenges(expires_at);
