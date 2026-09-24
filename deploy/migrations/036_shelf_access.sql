-- One person, one shelf (docs/specs/SIGN_IN_PROVIDERS.md § 8, § 10).
--
-- Provisional shelves: a browser that connects an agent without signing up
-- gets a shelf that lives in its session cookie only. It saves privately and
-- uses agents; it cannot hand out links until the person claims it with
-- Яндекс ID, VK ID or an address on an allowed domain (ч. 10 ст. 8 149-ФЗ).
-- Maintenance deletes one that nobody used for 30 days.
--
--   accounts.provisional_at  when the shelf was opened without sign-up; NULL
--                            for every other account.
--   accounts.claimed_at      when a sign-in method was attached to it (it is
--                            then an ordinary shelf). Never set without
--                            provisional_at.
--
-- Sign-in links from agents: an OAuth-connected agent may hand its owner a
-- one-time link back into the shelf it saves to (polka_open_shelf,
-- POST /api/v1/sign-in-link). The token lives in the link's #fragment; only
-- its SHA-256 is stored, for 5 minutes, used once.
--
--   agent_connections.sign_in_links  the owner allows this connection to
--                                    issue such links (default on).
--   agent_sign_in_links              one row per issued link; goes with its
--                                    connection. Maintenance deletes rows a
--                                    day after they expire.
--
-- shelf_claimed: the analytics event of a claim (props.method).
ALTER TABLE accounts
  ADD COLUMN provisional_at timestamptz,
  ADD COLUMN claimed_at timestamptz,
  ADD CONSTRAINT accounts_claim_needs_provisional
    CHECK (claimed_at IS NULL OR provisional_at IS NOT NULL);
-- Maintenance looks for unclaimed shelves only.
CREATE INDEX accounts_unclaimed_provisional ON accounts(provisional_at)
  WHERE provisional_at IS NOT NULL AND claimed_at IS NULL;

ALTER TABLE agent_connections
  ADD COLUMN sign_in_links boolean NOT NULL DEFAULT true;

CREATE TABLE agent_sign_in_links (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  connection_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX agent_sign_in_links_connection
  ON agent_sign_in_links(connection_id, created_at);
CREATE INDEX agent_sign_in_links_expiry ON agent_sign_in_links(expires_at);

ALTER TABLE analytics_events DROP CONSTRAINT analytics_events_name_check;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_name_check CHECK (name IN (
  'page_view','signup_completed','agent_connected','work_saved',
  'share_created','share_opened','note_added','enterprise_request',
  'recipient_cta_view','recipient_cta_click','shelf_claimed'
));
