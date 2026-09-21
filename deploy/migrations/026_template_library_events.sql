CREATE TABLE template_library_events (
  id bigserial PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES template_libraries(id),
  actor_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'template_library.created',
    'template_library.invitation_created',
    'template_library.invitation_accepted',
    'template_library.invitation_revoked',
    'template_library.member_revoked',
    'template_library.member_role_changed',
    'template_library.release_published',
    'template_library.publication_withdrawn'
  )),
  target_type text NOT NULL CHECK (target_type IN ('library','invitation','account','publication')),
  target_object_id uuid,
  target_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  old_role text CHECK (old_role IS NULL OR old_role IN ('reader','curator','admin')),
  new_role text CHECK (new_role IS NULL OR new_role IN ('reader','curator','admin')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (target_type='account' AND target_object_id IS NULL)
    OR (target_type<>'account' AND target_object_id IS NOT NULL AND target_account_id IS NULL)
  ),
  CHECK (
    (action='template_library.created' AND target_type='library'
      AND old_role IS NULL AND new_role='admin')
    OR (action='template_library.invitation_created' AND target_type='invitation'
      AND old_role IS NULL AND new_role IS NOT NULL)
    OR (action='template_library.invitation_accepted' AND target_type='account'
      AND old_role IS NULL AND new_role IS NOT NULL)
    OR (action IN ('template_library.invitation_revoked','template_library.member_revoked')
      AND target_type IN ('invitation','account') AND old_role IS NOT NULL AND new_role IS NULL)
    OR (action='template_library.member_role_changed' AND target_type='account'
      AND old_role IS NOT NULL AND new_role IS NOT NULL AND old_role<>new_role)
    OR (action IN ('template_library.release_published','template_library.publication_withdrawn')
      AND target_type='publication' AND old_role IS NULL AND new_role IS NULL)
  )
);

CREATE INDEX template_library_events_page
  ON template_library_events(library_id,id DESC);

CREATE FUNCTION preserve_template_library_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE'
     AND OLD.id=NEW.id
     AND OLD.library_id=NEW.library_id
     AND OLD.action=NEW.action
     AND OLD.target_type=NEW.target_type
     AND OLD.target_object_id IS NOT DISTINCT FROM NEW.target_object_id
     AND OLD.old_role IS NOT DISTINCT FROM NEW.old_role
     AND OLD.new_role IS NOT DISTINCT FROM NEW.new_role
     AND OLD.created_at=NEW.created_at
     AND (NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
          OR (OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL))
     AND (NEW.target_account_id IS NOT DISTINCT FROM OLD.target_account_id
          OR (OLD.target_account_id IS NOT NULL AND NEW.target_account_id IS NULL))
     AND (NEW.actor_id IS DISTINCT FROM OLD.actor_id
          OR NEW.target_account_id IS DISTINCT FROM OLD.target_account_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'template library events are append-only';
END $$;

CREATE TRIGGER template_library_event_immutable
  BEFORE UPDATE OR DELETE ON template_library_events
  FOR EACH ROW EXECUTE FUNCTION preserve_template_library_event();

CREATE FUNCTION redact_template_library_event_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.id=OLD.id
     AND NEW.name='deleted-'||NEW.id::text
     AND OLD.name IS DISTINCT FROM NEW.name
     AND NEW.email IS NULL AND NEW.display_name IS NULL
     AND NEW.disabled AND NEW.deletion_requested_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.account_purge_jobs purge
        WHERE purge.account_id=NEW.id
          AND purge.phase='source_empty'
          AND purge.source_empty_verified_at IS NOT NULL
          AND purge.local_mail_cleared_at IS NOT NULL
     ) THEN
    UPDATE public.template_library_events
       SET actor_id=CASE WHEN actor_id=NEW.id THEN NULL ELSE actor_id END,
           target_account_id=CASE WHEN target_account_id=NEW.id THEN NULL ELSE target_account_id END
     WHERE actor_id=NEW.id OR target_account_id=NEW.id;
    DELETE FROM public.audit_outbox
     WHERE target_id=NEW.id
       AND action IN ('template_library.member_role_changed','template_library.member_revoked');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER template_library_event_account_tombstone
  AFTER UPDATE OF name,email,display_name ON accounts
  FOR EACH ROW EXECUTE FUNCTION redact_template_library_event_tombstone();

REVOKE EXECUTE ON FUNCTION preserve_template_library_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION redact_template_library_event_tombstone() FROM PUBLIC;
