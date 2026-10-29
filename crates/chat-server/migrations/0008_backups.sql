-- Encrypted backups under a recovery key (ADR-0022). The server keeps the
-- latest backup per account and a hash of the auth secret derived from
-- the recovery key; it can read neither.
CREATE TABLE backups (
    account_id UUID PRIMARY KEY REFERENCES accounts ON DELETE CASCADE,
    auth_hash  BYTEA NOT NULL,
    blob       BYTEA,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
