-- A completion claim fences multipart part writers and expiry while the server
-- hashes ciphertext outside a database transaction. A stale claim may be
-- reclaimed, but publication always requires the same claim after re-locking.
ALTER TABLE blob_uploads ADD COLUMN completion_claim UUID;
ALTER TABLE blob_uploads ADD COLUMN completion_claimed_at TIMESTAMPTZ;
ALTER TABLE blob_uploads ADD CONSTRAINT blob_uploads_completion_claim_pair
    CHECK ((completion_claim IS NULL) = (completion_claimed_at IS NULL));
CREATE INDEX blob_uploads_completion_claim_idx
    ON blob_uploads (completion_claimed_at) WHERE completion_claim IS NOT NULL;
