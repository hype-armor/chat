-- Test-only. This does not activate an account registry and is not a migration.
-- PostgreSQL table owners can disable triggers or change the guard. A deployment
-- needs separately reviewed roles and privileges before this is enforceable.
CREATE TABLE presence_legacy_cutover_guard (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    frozen boolean NOT NULL DEFAULT false
);
INSERT INTO presence_legacy_cutover_guard DEFAULT VALUES;

CREATE FUNCTION presence_legacy_guard_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT frozen FROM presence_legacy_cutover_guard WHERE singleton) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'legacy presence registry is frozen';
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER presence_legacy_scopes_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
    ON presence_replacement_scopes FOR EACH STATEMENT EXECUTE FUNCTION presence_legacy_guard_write();
CREATE TRIGGER presence_legacy_history_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
    ON presence_replacement_history FOR EACH STATEMENT EXECUTE FUNCTION presence_legacy_guard_write();

CREATE FUNCTION presence_test_freeze_empty_legacy() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- RowExclusiveLock for every ordinary write conflicts with these locks.
    -- Acquire both before checking either table, and hold them until commit.
    LOCK TABLE presence_replacement_scopes, presence_replacement_history IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM presence_replacement_scopes) OR
       EXISTS (SELECT 1 FROM presence_replacement_history) THEN
        RAISE EXCEPTION 'legacy presence registry is not empty';
    END IF;
    UPDATE presence_legacy_cutover_guard SET frozen = true WHERE singleton;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing legacy guard'; END IF;
END $$;
