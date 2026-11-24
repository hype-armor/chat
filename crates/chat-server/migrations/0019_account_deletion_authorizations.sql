-- A digest of a client-generated secret. The secret is never stored here.
CREATE TABLE account_deletion_authorizations (
    account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    secret_hash bytea NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    PRIMARY KEY (account_id, secret_hash)
);
