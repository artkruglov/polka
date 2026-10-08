-- A request from /enterprise is one field: how to reach the person — a work
-- e-mail or a Telegram username. Name, company and team size become optional
-- (the short form does not ask for them); what the person wants defaults to
-- «другое».
ALTER TABLE enterprise_requests RENAME COLUMN email TO contact;
ALTER TABLE enterprise_requests
  ALTER COLUMN name DROP NOT NULL,
  ALTER COLUMN company DROP NOT NULL,
  ALTER COLUMN team_size DROP NOT NULL,
  ALTER COLUMN interest SET DEFAULT 'other';
