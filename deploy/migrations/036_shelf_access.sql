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

-- Off for every connection that exists: consent already given is not widened
-- after the fact. A new connection gets it only when its owner ticks the
-- sign_in permission on the consent page.
ALTER TABLE agent_connections
  ADD COLUMN sign_in_links boolean NOT NULL DEFAULT false;

-- sign_in: «Давать ссылку для входа» — a separate permission, off by
-- default on the consent page, never implied by context.
ALTER TABLE agent_connections DROP CONSTRAINT agent_connections_scopes_check,
  ADD CONSTRAINT agent_connections_scopes_check CHECK (
    cardinality(scopes) BETWEEN 1 AND 8
    AND scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage','sign_in']::text[]);
ALTER TABLE oauth_authorizations
  DROP CONSTRAINT oauth_authorizations_requested_scopes_check,
  ADD CONSTRAINT oauth_authorizations_requested_scopes_check CHECK (
    cardinality(requested_scopes) BETWEEN 1 AND 8
    AND requested_scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage','sign_in']::text[]),
  DROP CONSTRAINT oauth_authorizations_granted_scopes_check,
  ADD CONSTRAINT oauth_authorizations_granted_scopes_check CHECK (
    cardinality(granted_scopes) BETWEEN 1 AND 8
    AND granted_scopes <@ ARRAY['context','read','source:read','capture','revise','share','manage','sign_in']::text[]);

-- How strongly a session proves its owner. agent_link: opened by a sign-in
-- link from an agent; it browses and may be upgraded by a real sign-in, but
-- cannot claim, merge, link or unlink sign-in methods, manage agents or
-- delete the account.
ALTER TABLE sessions
  ADD COLUMN assurance text NOT NULL DEFAULT 'full'
    CHECK (assurance IN ('full','agent_link'));

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
