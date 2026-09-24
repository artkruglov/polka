-- First-party product analytics (docs/legal/privacy.md, «Статистика
-- использования»; deploy/hosted/README.md, «Метрики продукта»).
--
-- The application writes these rows itself, on its own server: no cookies,
-- no third-party scripts, no IP addresses, no user agents, no full URLs.
--
-- analytics_events       One step someone took: a landing page was loaded,
--                        an account was created, an agent connected, a work
--                        saved, a link made or opened, a note added, a
--                        company request sent. Kept 13 months (maintenance).
--   actor                HMAC-SHA256 of the account id under a key derived
--                        from LINK_KEY (base64url). Never the id or an
--                        address. NULL for anonymous events (page views,
--                        company requests).
--   subject              For share_opened only: the same kind of HMAC of the
--                        share id, so a link counts at most once a day. The
--                        viewer is never identified.
--   props                A few enumerated values (method, client, via,
--                        first, the sanitised ref and referrer host).
-- analytics_daily        Anonymous counters per day, event and dimension.
--                        Kept after the raw events expire.
-- analytics_active_days  An account (the same HMAC) was active that day:
--                        retention. Kept 13 months.
-- analytics_optouts      Accounts (the same HMAC) that objected: their events
--                        were deleted and new ones are not written.
--
-- Account deletion removes the account's events in the request transaction;
-- maintenance also removes those of every deleted account (a restored backup
-- or a purge by the operator), because only the application knows the key.

CREATE TABLE analytics_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,
  name text NOT NULL CHECK (name IN (
    'page_view','signup_completed','agent_connected','work_saved',
    'share_created','share_opened','note_added','enterprise_request'
  )),
  actor text CHECK (actor ~ '^[A-Za-z0-9_-]{43}$'),
  subject text CHECK (subject ~ '^[A-Za-z0-9_-]{43}$'),
  props jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(props)='object' AND octet_length(props::text)<=512),
  CHECK ((name='share_opened')=(subject IS NOT NULL))
);
CREATE INDEX analytics_events_occurred ON analytics_events(occurred_at);
CREATE INDEX analytics_events_name_day ON analytics_events(name, day);
CREATE INDEX analytics_events_actor ON analytics_events(actor, name)
  WHERE actor IS NOT NULL;
-- A link counts as opened at most once a day.
CREATE UNIQUE INDEX analytics_share_opened_daily ON analytics_events(subject, day)
  WHERE name='share_opened';

CREATE TABLE analytics_daily (
  day date NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  path text NOT NULL DEFAULT '' CHECK (char_length(path)<=40),
  source text NOT NULL DEFAULT '' CHECK (char_length(source)<=120),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail)<=40),
  count bigint NOT NULL CHECK (count>0),
  PRIMARY KEY (day, name, path, source, detail)
);

CREATE TABLE analytics_active_days (
  actor text NOT NULL CHECK (actor ~ '^[A-Za-z0-9_-]{43}$'),
  day date NOT NULL,
  PRIMARY KEY (actor, day)
);
CREATE INDEX analytics_active_days_day ON analytics_active_days(day);

CREATE TABLE analytics_optouts (
  actor text PRIMARY KEY CHECK (actor ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
