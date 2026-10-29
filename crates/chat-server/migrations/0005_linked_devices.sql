-- Device links by QR code (ADR-0019). Only a hash of the one-time code is
-- stored; account_id is set when a signed-in device approves the link and
-- device_id when the new device completes it.
CREATE TABLE link_requests (
    code_hash  BYTEA PRIMARY KEY,
    account_id UUID REFERENCES accounts ON DELETE CASCADE,
    device_id  UUID REFERENCES devices ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX link_requests_expires_idx ON link_requests (expires_at);
