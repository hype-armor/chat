-- Server-side data model (docs/03-architecture.md §6). The server never
-- stores message content, contact lists, group membership, or locations.

CREATE TABLE accounts (
    account_id   UUID PRIMARY KEY,
    -- E.164 phone number, needed for login and SMS (ADR-0011).
    phone_number TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    device_id          UUID PRIMARY KEY,
    account_id         UUID NOT NULL REFERENCES accounts ON DELETE CASCADE,
    identity_key       BYTEA NOT NULL,
    -- Web Push subscription JSON (endpoint + keys); NULL until granted.
    push_subscription  JSONB,
    -- Day granularity only, to limit presence metadata.
    last_seen_day      DATE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_account_idx ON devices (account_id);

-- Single-use MLS key packages published by each device.
CREATE TABLE key_packages (
    key_package_id BIGSERIAL PRIMARY KEY,
    device_id      UUID NOT NULL REFERENCES devices ON DELETE CASCADE,
    key_package    BYTEA NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX key_packages_device_idx ON key_packages (device_id, expires_at);

-- Delivery queue: one row per recipient device, deleted on ack or after
-- 30 days (FR-MSG-9).
CREATE TABLE queued_envelopes (
    queue_id            BIGSERIAL PRIMARY KEY,
    recipient_device_id UUID NOT NULL REFERENCES devices ON DELETE CASCADE,
    message_id          BYTEA NOT NULL,
    envelope            BYTEA NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (recipient_device_id, message_id)
);
CREATE INDEX queued_envelopes_received_idx ON queued_envelopes (received_at);

-- Per-group commit ordering: exactly one commit is accepted per epoch
-- (docs/03-architecture.md §5.3). group_id is the opaque MLS group id.
CREATE TABLE group_epochs (
    group_id         BYTEA PRIMARY KEY,
    epoch            BIGINT NOT NULL,
    last_commit_hash BYTEA NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Encrypted attachments live in object storage; this tracks expiry only.
CREATE TABLE blobs (
    blob_id    UUID PRIMARY KEY,
    size_bytes BIGINT NOT NULL CHECK (size_bytes <= 104857600 + 1048576),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX blobs_expires_idx ON blobs (expires_at);
