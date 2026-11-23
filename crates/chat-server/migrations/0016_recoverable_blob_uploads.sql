-- Caller-chosen transfer identifiers fence multipart create and completion retries.
-- They contain only opaque UUIDs, ciphertext size, and ciphertext SHA-256.
-- Keep rows after expiry so an expired or tombstoned transfer never creates
-- another reservation or object set.
CREATE TABLE blob_upload_transfers (
    transfer_id UUID NOT NULL,
    device_id UUID NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 104857600 + 1048576),
    ciphertext_sha256 BYTEA NOT NULL CHECK (octet_length(ciphertext_sha256) = 32),
    upload_id UUID NOT NULL UNIQUE,
    blob_id UUID UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('uploading', 'complete', 'expired')),
    PRIMARY KEY (device_id, transfer_id)
);
CREATE INDEX blob_upload_transfers_blob_idx ON blob_upload_transfers (blob_id) WHERE blob_id IS NOT NULL;
