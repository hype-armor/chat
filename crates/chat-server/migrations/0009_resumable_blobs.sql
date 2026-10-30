-- Resumable transfers (ADR-0025). A blob uploaded in parts keeps them as
-- separate objects, `blobs/{id}/{n}`; `parts = 0` is a single object,
-- `blobs/{id}`.
ALTER TABLE blobs ADD COLUMN parts INT NOT NULL DEFAULT 0 CHECK (parts >= 0);

-- Uploads in progress, kept a day. No foreign key to the device: the
-- expiry job must still find their parts after the device is deleted.
CREATE TABLE blob_uploads (
    upload_id  UUID PRIMARY KEY,
    device_id  UUID NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 104857600 + 1048576),
    parts      INT NOT NULL CHECK (parts > 0),
    received   INT[] NOT NULL DEFAULT '{}',
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX blob_uploads_expires_idx ON blob_uploads (expires_at);
