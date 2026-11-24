-- Experimental only: no route enables these tables. Presence is not queued.
CREATE TABLE presence_versions (
    account_id UUID PRIMARY KEY REFERENCES accounts ON DELETE CASCADE,
    version BIGINT NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE presence_grants (
    sender UUID NOT NULL REFERENCES accounts ON DELETE CASCADE,
    recipient UUID NOT NULL REFERENCES accounts ON DELETE CASCADE,
    generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (sender, recipient),
    CHECK (sender <> recipient)
);
CREATE TABLE presence_leases (
    sender UUID NOT NULL,
    recipient UUID NOT NULL,
    device UUID NOT NULL REFERENCES devices ON DELETE CASCADE,
    generation BIGINT NOT NULL,
    ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 8192),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (sender, recipient, device),
    FOREIGN KEY (sender, recipient) REFERENCES presence_grants ON DELETE CASCADE
);
CREATE INDEX presence_leases_expiry ON presence_leases (expires_at);
CREATE TABLE presence_rate_limits (
    device UUID NOT NULL REFERENCES devices ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('write', 'poll')),
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (device, action)
);
