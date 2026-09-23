-- Sign-in through external identity providers (docs/specs/SIGN_IN_PROVIDERS.md).
--
-- account_identities  One account of a provider (Яндекс ID, VK ID, the
--                     installation's own OIDC) linked to a Полка account.
--                     subject is the provider's stable user id; email is what
--                     the provider reported when the link was made (NULL when
--                     it reported none) and email_verified whether the
--                     provider vouches for it. No provider tokens are stored.
-- template_library_events  + template_library.domain_joined: a person joined
--                     a library by the installation's organisation setting
--                     (ORG_DOMAINS, OIDC_ORG_LIBRARY), acting on their own
--                     sign-in.
--
-- Erasure: identities go as soon as an account asks to be deleted (the
-- request, a restored erasure and the terminal purge all set
-- deletion_requested_at), by a trigger, so terminal_erase_account_metadata is
-- not redefined here. Version 031 belongs to a concurrent branch; this file
-- does not depend on it.

CREATE TABLE account_identities (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('yandex','vk','oidc')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  email text CHECK (email IS NULL OR char_length(email) <= 254),
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, subject),
  CHECK (email IS NOT NULL OR NOT email_verified)
);
CREATE INDEX account_identities_account ON account_identities(account_id);

CREATE FUNCTION erase_account_identities() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  DELETE FROM public.account_identities WHERE account_id=NEW.id;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION erase_account_identities() FROM PUBLIC;

CREATE TRIGGER account_identities_erased
  AFTER UPDATE OF deletion_requested_at,email,name ON accounts
  FOR EACH ROW WHEN (NEW.deletion_requested_at IS NOT NULL)
  EXECUTE FUNCTION erase_account_identities();

ALTER TABLE template_library_events
  DROP CONSTRAINT template_library_events_action_check,
  ADD CONSTRAINT template_library_events_action_check CHECK (action IN (
    'template_library.created',
    'template_library.invitation_created',
    'template_library.invitation_accepted',
    'template_library.invitation_revoked',
    'template_library.member_revoked',
    'template_library.member_role_changed',
    'template_library.release_published',
    'template_library.publication_withdrawn',
    'template_library.domain_joined'
  )),
  DROP CONSTRAINT template_library_events_check1,
  ADD CONSTRAINT template_library_events_check1 CHECK (
    (action='template_library.created' AND target_type='library'
      AND old_role IS NULL AND new_role='admin')
    OR (action='template_library.invitation_created' AND target_type='invitation'
      AND old_role IS NULL AND new_role IS NOT NULL)
    OR (action IN ('template_library.invitation_accepted','template_library.domain_joined')
      AND target_type='account' AND old_role IS NULL AND new_role IS NOT NULL)
    OR (action IN ('template_library.invitation_revoked','template_library.member_revoked')
      AND target_type IN ('invitation','account') AND old_role IS NOT NULL AND new_role IS NULL)
    OR (action='template_library.member_role_changed' AND target_type='account'
      AND old_role IS NOT NULL AND new_role IS NOT NULL AND old_role<>new_role)
    OR (action IN ('template_library.release_published','template_library.publication_withdrawn')
      AND target_type='publication' AND old_role IS NULL AND new_role IS NULL)
  );
