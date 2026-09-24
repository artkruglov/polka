-- Recipient conversion events (apps/server/recipient-cta.ts,
-- docs/specs/RECIPIENT_CONVERSION.md): a guest who opened a shared work saw
-- or pressed the «сделано на Полке» prompt.
--
--   recipient_cta_view   props.surface = bar | card
--   recipient_cta_click  props.action  = try | remix | copy_phrase | yandex | email
--
-- Anonymous like page_view: no actor, no subject, and never the link's token
-- (the browser sends only the event name and one enumerated value).
ALTER TABLE analytics_events DROP CONSTRAINT analytics_events_name_check;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_name_check CHECK (name IN (
  'page_view','signup_completed','agent_connected','work_saved',
  'share_created','share_opened','note_added','enterprise_request',
  'recipient_cta_view','recipient_cta_click'
));
