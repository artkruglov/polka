-- The shelf's card: free text of its curator, "how we do things here", given
-- first to an agent that connects (polka_context; docs/specs/DATA_MODELS.md §6).
-- Null: no card. It is on the shelf's row, so erasing a shelf erases it.
ALTER TABLE tenants
  ADD COLUMN card_md text NULL CHECK (char_length(card_md) <= 8000);
