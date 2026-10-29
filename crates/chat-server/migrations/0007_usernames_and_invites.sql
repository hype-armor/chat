-- Usernames and invite-only sign-up replace phone numbers (ADR-0021).
ALTER TABLE accounts ADD COLUMN username TEXT;
-- Accounts from the phone era get a placeholder username.
UPDATE accounts
SET username = 'user' || substr(replace(account_id::text, '-', ''), 1, 8) || '.' || lpad((floor(random() * 100))::int::text, 2, '0');
ALTER TABLE accounts
    ALTER COLUMN username SET NOT NULL,
    ADD CONSTRAINT accounts_username_key UNIQUE (username),
    DROP COLUMN phone_number;

DROP TABLE verification_codes;
DROP TABLE code_requests;

-- Unused invites only: a row is deleted when its invite is used, so who
-- invited whom is never stored.
CREATE TABLE invites (
    code_hash  BYTEA PRIMARY KEY,
    created_by UUID REFERENCES accounts ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX invites_created_by_idx ON invites (created_by, expires_at);
CREATE INDEX invites_expires_idx ON invites (expires_at);
