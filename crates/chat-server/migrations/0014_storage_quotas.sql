-- Object-store ciphertext only. Every ledger row counts, including reservations.
-- Retirement durably fences old transactions whose now() predates expiry.
ALTER TABLE blob_uploads ADD COLUMN retiring BOOLEAN NOT NULL DEFAULT FALSE;

-- Operators must lock this singleton before changing either policy table.
CREATE TABLE storage_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    server_bytes BIGINT CHECK (server_bytes >= 0),
    account_bytes BIGINT DEFAULT 2147483648 CHECK (account_bytes >= 0)
);
INSERT INTO storage_policy (id) VALUES (1);

-- Absent row: inherit. NULL limit: unlimited. Zero: no new allocation.
CREATE TABLE account_storage_policy (
    account_id UUID PRIMARY KEY REFERENCES accounts ON DELETE CASCADE,
    limit_bytes BIGINT CHECK (limit_bytes >= 0)
);

CREATE TABLE storage_objects (
    object_key TEXT PRIMARY KEY,
    account_id UUID REFERENCES accounts ON DELETE SET NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'writing', 'ready', 'live'))
);
CREATE INDEX storage_objects_account_idx ON storage_objects (account_id);

-- Split completed multipart blobs into their physical object keys.
INSERT INTO storage_objects (object_key, account_id, size_bytes, state)
SELECT 'blobs/' || blob_id, account_id, size_bytes, 'live'
FROM blobs WHERE parts = 0;
INSERT INTO storage_objects (object_key, account_id, size_bytes, state)
SELECT 'blobs/' || b.blob_id || '/' || n.part, b.account_id,
       LEAST(8388608::bigint, b.size_bytes - n.part::bigint * 8388608), 'live'
FROM blobs b CROSS JOIN LATERAL generate_series(0, b.parts - 1) AS n(part)
WHERE b.parts > 0;

-- Reserve the full size, even for absent parts and expired sessions.
-- The device might already be gone. Preserve those bytes as global usage.
INSERT INTO storage_objects (object_key, account_id, size_bytes, state)
SELECT 'blobs/' || u.upload_id || '/' || n.part, d.account_id,
       LEAST(8388608::bigint, u.size_bytes - n.part::bigint * 8388608),
       CASE WHEN n.part = ANY(u.received) THEN 'ready' ELSE 'reserved' END
FROM blob_uploads u LEFT JOIN devices d USING (device_id)
CROSS JOIN LATERAL generate_series(0, u.parts - 1) AS n(part)
ON CONFLICT (object_key) DO NOTHING;

INSERT INTO storage_objects (object_key, account_id, size_bytes, state)
SELECT object_key, account_id, coalesce(size_bytes, octet_length(blob), 104857600), 'live'
FROM backups WHERE object_key IS NOT NULL;
-- Startup moves legacy database backups into this reserved object key.
INSERT INTO storage_objects (object_key, account_id, size_bytes)
SELECT 'backups/' || account_id || '/legacy', account_id, octet_length(blob)
FROM backups WHERE blob IS NOT NULL AND object_key IS NULL;

-- Legacy blobs without owners remain global usage. Objects already orphaned
-- before this migration require an operator inventory and ledger import.
-- Never automatically release abandoned reservations: a writer can still run.
