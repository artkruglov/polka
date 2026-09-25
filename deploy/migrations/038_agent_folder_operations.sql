-- Folders through MCP (polka_create_folder, polka_rename_folder,
-- polka_delete_folder, polka_move): each is an idempotent agent operation
-- keyed like polka_update_artifact, so a retried call returns what it did.
--
--   folder-create  a new folder on the shelf
--   folder-rename  a folder's new name
--   folder-delete  an empty folder removed
--   move           up to 100 works moved into a folder (or out of any) at once
ALTER TABLE agent_operations
  DROP CONSTRAINT agent_operations_operation_check,
  ADD CONSTRAINT agent_operations_operation_check
    CHECK(operation IN ('share','metadata','share-move',
                        'folder-create','folder-rename','folder-delete','move'));
