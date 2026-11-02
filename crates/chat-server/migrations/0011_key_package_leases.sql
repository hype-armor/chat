-- Key packages are leased, not deleted, when someone claims them (audit M3).
-- A claim that never becomes a welcome must not use up a person's packages,
-- and a stranger must not be able to empty them.
ALTER TABLE key_packages
    ADD COLUMN claimed_by UUID REFERENCES devices ON DELETE SET NULL,
    ADD COLUMN claimed_at TIMESTAMPTZ;
-- A package is free while claimed_by is NULL.
CREATE INDEX key_packages_free_idx
    ON key_packages (device_id, key_package_id) WHERE claimed_by IS NULL;
