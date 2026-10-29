-- Send authorisation (ADR-0017).

-- Devices allowed to send to and receive from each conversation. A device is
-- added when it creates the conversation or receives a welcome to it.
CREATE TABLE conversation_members (
    conversation_id BYTEA NOT NULL,
    device_id       UUID NOT NULL REFERENCES devices ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, device_id)
);
CREATE INDEX conversation_members_device_idx ON conversation_members (device_id);

-- Key packages a device claimed, so welcomes (first contact) can only go to
-- devices the sender legitimately looked up.
CREATE TABLE key_package_claims (
    claimer_device_id UUID NOT NULL REFERENCES devices ON DELETE CASCADE,
    claimed_device_id UUID NOT NULL REFERENCES devices ON DELETE CASCADE,
    claimed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (claimer_device_id, claimed_device_id)
);
