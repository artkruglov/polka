-- Webhooks (docs/specs/WEBHOOKS.md): HTTPS addresses a shelf's owner (or a
-- department shelf's admin) registers, and the events of the shelf Полка
-- sends to them, signed. The events are rows of audit_outbox read in commit
-- order by one cursor; a delivery is a row per event and address with its
-- attempts. No content of a work: the body is the event of the agents' feed.

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Who answers for it: an active admin of the shelf (its owner on a
  -- personal one). Leaving the shelf, losing the role or being disabled
  -- switches it off (triggers below).
  created_by uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 2000),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  events text[] NOT NULL CHECK (
    cardinality(events) BETWEEN 1 AND 10
    AND events <@ ARRAY['revision.saved','revision.accepted','owner.changed',
      'artifact.metadata_updated','artifact.moved','artifact.trashed','artifact.restored',
      'share.enabled','share.revoked','comment.created']::text[]),
  -- The signing secret, encrypted with a key derived from LINK_KEY and bound
  -- to this row's id (AES-256-GCM: iv, tag, ciphertext); shown once.
  secret_enc bytea NOT NULL,
  secret_hint text NOT NULL CHECK (char_length(secret_hint) <= 16),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason text CHECK (disabled_reason IN ('owner', 'failures', 'creator')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failing_since timestamptz,
  -- The circuit breaker: after several failures in a row the address as a
  -- whole waits, whatever its deliveries' own schedule.
  paused_until timestamptz,
  -- Events not queued because the address already had too many waiting.
  skipped_events integer NOT NULL DEFAULT 0 CHECK (skipped_events >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active') = (disabled_reason IS NULL))
);
CREATE INDEX webhook_endpoints_tenant ON webhook_endpoints (tenant_id, created_at);
CREATE INDEX webhook_endpoints_creator ON webhook_endpoints (created_by);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The feed's event id (tx:id), or ping:<uuid> for «Проверить».
  event_id text NOT NULL CHECK (char_length(event_id) <= 80),
  action text NOT NULL CHECK (char_length(action) <= 40),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  -- Set while an attempt is in flight; a crashed sender's lease runs out.
  leased_until timestamptz,
  last_attempt_at timestamptz,
  last_status integer,
  last_error text CHECK (char_length(last_error) <= 40),
  -- Never the receiver's whole answer: its first characters, for the log.
  response_snippet text CHECK (char_length(response_snippet) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id),
  CHECK ((state = 'pending') = (next_attempt_at IS NOT NULL))
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state = 'pending';
-- The sender picks a few due deliveries per address, then counts what is in flight.
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (endpoint_id, next_attempt_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_leased ON webhook_deliveries (endpoint_id)
  WHERE state = 'pending' AND leased_until IS NOT NULL;
CREATE INDEX webhook_deliveries_log ON webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX webhook_deliveries_age ON webhook_deliveries (created_at);

-- Where the dispatcher stopped in audit_outbox, (tx_id, id) as in the feed.
-- One row; NULL until the dispatcher first runs, which starts at the end.
CREATE TABLE webhook_dispatch_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tx xid8,
  event_id bigint
);
INSERT INTO webhook_dispatch_cursor (singleton) VALUES (true);

-- Erasure (ACCOUNT_DELETION_SPEC): the tenants and accounts rows stay, so the
-- cascades never fire. The deletion request takes the webhooks of the
-- person's own shelf and those the person registered on department shelves,
-- with their delivery logs; the rename that ends the erasure (030), which the
-- restore reconciler runs too, takes them again from an older copy.
CREATE FUNCTION erase_account_webhooks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM public.webhook_endpoints endpoint
   WHERE endpoint.created_by=NEW.id
      OR endpoint.tenant_id IN (SELECT tenant.id FROM public.tenants tenant
                                 WHERE tenant.owner_id=NEW.id AND tenant.kind<>'team');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION erase_account_webhooks() FROM PUBLIC;

CREATE TRIGGER erase_account_webhooks
  AFTER UPDATE OF deletion_requested_at,name ON accounts
  FOR EACH ROW
  WHEN (NEW.deletion_requested_at IS NOT NULL
        OR (NEW.name = 'deleted-' || NEW.id::text AND OLD.name IS DISTINCT FROM NEW.name))
  EXECUTE FUNCTION erase_account_webhooks();

-- A webhook answers to the person who registered it (or last switched it on):
-- when that person leaves a department shelf, stops being its admin or is
-- disabled, it is switched off ('creator') with whatever waits; another admin
-- may switch it on again and answers for it from then on. A personal shelf's
-- owner who is disabled (often for a while: a moderation or content-filter
-- freeze) is not switched off: the sender skips the shelf while the owner is
-- disabled (webhooks.ts) and resumes after.
CREATE FUNCTION webhooks_lose_creator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  shelf uuid;
  person uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenant_members' THEN
    shelf := NEW.tenant_id;
    person := NEW.account_id;
  ELSE
    person := NEW.id;
  END IF;
  WITH off AS (
    UPDATE public.webhook_endpoints endpoint
       SET status='disabled',disabled_reason='creator',updated_at=now()
     WHERE endpoint.created_by=person AND endpoint.status='active'
       AND (shelf IS NULL OR endpoint.tenant_id=shelf)
       AND EXISTS(SELECT 1 FROM public.tenants tenant
                   WHERE tenant.id=endpoint.tenant_id AND tenant.kind='team')
    RETURNING endpoint.id
  )
  UPDATE public.webhook_deliveries delivery
     SET state='failed',next_attempt_at=NULL,leased_until=NULL,last_error='endpoint_disabled'
   WHERE delivery.endpoint_id IN (SELECT id FROM off) AND delivery.state='pending';
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION webhooks_lose_creator() FROM PUBLIC;

CREATE TRIGGER webhooks_member_left
  AFTER UPDATE OF state,role ON tenant_members
  FOR EACH ROW
  WHEN (NEW.state <> 'active' OR NEW.role NOT IN ('admin', 'owner'))
  EXECUTE FUNCTION webhooks_lose_creator();

CREATE TRIGGER webhooks_account_disabled
  AFTER UPDATE OF disabled ON accounts
  FOR EACH ROW
  WHEN (NEW.disabled AND NOT OLD.disabled)
  EXECUTE FUNCTION webhooks_lose_creator();
