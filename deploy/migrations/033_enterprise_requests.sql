-- Requests from the page for companies (/enterprise).
--
-- A person asks about the cloud, their own installation or a commercial
-- license. The row is what the operator answers; the same fields go to
-- OPERATOR_EMAIL as a plain-text letter. Maintenance deletes a request one
-- year after it was made (the privacy policy promises this).
--
-- idempotency_key  The form's key: a repeated submit is one request.
-- notified_at      When the letter to the operator was accepted; NULL when
--                  mail is off or the letter failed (the row still counts).
--
-- The number 033 follows 031 (content filter) and 032 (account identities),
-- which land from concurrent branches; this migration depends on neither.

CREATE TABLE enterprise_requests (
  id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  company text NOT NULL CHECK (char_length(company) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  team_size text NOT NULL
    CHECK (team_size IN ('1-10','11-50','51-200','201-1000','1000+')),
  interest text NOT NULL
    CHECK (interest IN ('cloud','self-hosted','commercial-license','other')),
  comment text CHECK (char_length(comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
CREATE INDEX enterprise_requests_created ON enterprise_requests(created_at);
