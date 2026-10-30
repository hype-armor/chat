-- Backups move into the blob store (ADR-0022, Phase 2 item 9): the row
-- keeps the auth hash and names the object. `blob` holds backups made
-- before the move until the server copies them out at startup; a later
-- migration drops it.
ALTER TABLE backups
    ADD COLUMN object_key TEXT,
    ADD COLUMN size_bytes BIGINT;
