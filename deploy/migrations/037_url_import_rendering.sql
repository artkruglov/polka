-- URL import: a job waits in «rendering» while the isolated renderer opens an
-- allowlisted SPA page (docs/specs/URL_IMPORT_SUPPORT.md, «Рендерер»). The
-- state is a pending one like «fetching»: claimable, leased and expirable.
ALTER TABLE url_import_jobs DROP CONSTRAINT url_import_jobs_state_check;
ALTER TABLE url_import_jobs ADD CONSTRAINT url_import_jobs_state_check
  CHECK (state IN ('queued','fetching','rendering','prepared','saving','previewing','ready','partial','failed','cancelled'));
DROP INDEX url_import_jobs_pending;
CREATE INDEX url_import_jobs_pending ON url_import_jobs(created_at,id)
  WHERE state IN ('queued','fetching','rendering','prepared','saving','previewing');
