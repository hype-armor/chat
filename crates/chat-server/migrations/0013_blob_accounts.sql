-- Attachment storage is capped per account (audit M8), not only per device
-- per day: an account must not be able to accumulate unbounded bytes.
ALTER TABLE blobs ADD COLUMN account_id UUID REFERENCES accounts ON DELETE CASCADE;
CREATE INDEX blobs_account_idx ON blobs (account_id, expires_at);
