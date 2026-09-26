-- Links out of department shelves (docs/specs/TEAM_SHELVES.md, stage 5).
--
-- shares  + created_by: who issued the link. On a personal shelf it is the
--           shelf's owner (backfilled); on a department shelf, which has no
--           owner, it is the member who issued it. The account that answers
--           for a link — whose standing moderation weighs, who gets the
--           letters, whose disabling closes it — is the shelf's owner, else
--           the issuer: COALESCE(tenants.owner_id, shares.created_by).
ALTER TABLE shares ADD COLUMN created_by uuid REFERENCES accounts(id);

UPDATE shares share SET created_by = tenant.owner_id
FROM tenants tenant
WHERE tenant.id = share.tenant_id AND share.created_by IS NULL;

CREATE INDEX shares_created_by ON shares (created_by) WHERE created_by IS NOT NULL;
