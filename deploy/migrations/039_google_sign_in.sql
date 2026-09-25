-- Sign-in with Google (docs/specs/SIGN_IN_PROVIDERS.md, «Google»).
--
-- account_identities  + provider 'google' (subject = the id_token's `sub`).
--                     + hosted_domain: the Google Workspace domain from the
--                     `hd` claim, when Google sent one (NULL for a personal
--                     account and for every other provider). Stored for the
--                     operator and organisation rules; never required.
--
-- Erasure: the trigger of 032 (erase_account_identities) deletes every
-- identity row of an account that asks to be deleted, whatever its
-- provider, so a Google identity and its hosted_domain go with the same
-- statement at the request, a restored erasure and the terminal purge. No
-- erasure or purge function changes here, and no grant: the runtime role
-- already holds table-level SELECT, INSERT, UPDATE, DELETE on the table.
-- Self-contained: depends only on 032.

ALTER TABLE account_identities
  DROP CONSTRAINT account_identities_provider_check,
  ADD CONSTRAINT account_identities_provider_check
    CHECK (provider IN ('yandex','vk','oidc','google')),
  ADD COLUMN hosted_domain text,
  ADD CONSTRAINT account_identities_hosted_domain_check CHECK (
    hosted_domain IS NULL
    OR (provider = 'google' AND char_length(hosted_domain) BETWEEN 1 AND 253
        AND hosted_domain = lower(hosted_domain))
  );
