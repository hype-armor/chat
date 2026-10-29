-- Device authentication and phone verification (ADR-0011).

-- SHA-256 of the device's bearer token; the token itself is never stored.
ALTER TABLE devices ADD COLUMN auth_token_hash BYTEA UNIQUE;

-- Pending one-time codes, one per phone number.
CREATE TABLE verification_codes (
    phone_number TEXT PRIMARY KEY,
    code_hash    BYTEA NOT NULL,
    attempts     INT NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ NOT NULL
);

-- Code-request log for rate limiting (SMS-pumping protection, NFR-LEG-5).
CREATE TABLE code_requests (
    phone_number TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX code_requests_phone_idx ON code_requests (phone_number, requested_at);
