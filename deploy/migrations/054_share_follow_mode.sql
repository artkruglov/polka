-- Whether a link follows new versions of its work on its own
-- (docs/specs/DATA_MODELS.md §2).
--
-- 'pinned' (the default, and what every existing link gets): the link stays on
-- its version until a person moves it. 'follows': an unattended agent (a
-- service account) may move it when it saves a new version. A person's own
-- publish and polka_share moveShareId behave as before whatever the mode.
ALTER TABLE shares
  ADD COLUMN follow_mode text NOT NULL DEFAULT 'pinned'
    CHECK (follow_mode IN ('pinned','follows'));
