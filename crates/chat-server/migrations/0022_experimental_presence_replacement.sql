-- Internal experiment only. No cascades: these rows are replay tombstones.
-- Their deletion and retention policy must be settled before activation.
CREATE TABLE presence_replacement_scopes (
    sender_device UUID NOT NULL,
    recipient UUID NOT NULL,
    direct_id BYTEA NOT NULL CHECK (octet_length(direct_id) BETWEEN 1 AND 256),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
    active_group BYTEA CHECK (octet_length(active_group) BETWEEN 1 AND 256),
    PRIMARY KEY (sender_device, recipient, direct_id),
    CHECK ((generation = 0) = (active_group IS NULL))
);
CREATE TABLE presence_replacement_history (
    sender_device UUID NOT NULL,
    recipient UUID NOT NULL,
    direct_id BYTEA NOT NULL,
    operation UUID NOT NULL,
    expected BIGINT NOT NULL CHECK (expected BETWEEN 0 AND 9007199254740990),
    generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991 AND generation > expected),
    group_id BYTEA NOT NULL CHECK (octet_length(group_id) BETWEEN 1 AND 256),
    PRIMARY KEY (sender_device, recipient, direct_id, operation),
    UNIQUE (sender_device, recipient, direct_id, group_id),
    FOREIGN KEY (sender_device, recipient, direct_id)
        REFERENCES presence_replacement_scopes (sender_device, recipient, direct_id)
);
