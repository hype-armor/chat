-- Default-off preparation only. This migration does not freeze legacy writes,
-- inspect inventory, activate presence, or remove replay history.
-- The guard assumes an honest server and table owner, and no database rollback.
-- An owner who changes the guard, function, or triggers can bypass this fence.
CREATE TABLE presence_legacy_cutover_guard (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    frozen BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO presence_legacy_cutover_guard DEFAULT VALUES;

CREATE FUNCTION presence_legacy_guard_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT frozen FROM presence_legacy_cutover_guard WHERE singleton) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'legacy presence registry is frozen';
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER presence_legacy_scopes_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
    ON presence_replacement_scopes FOR EACH STATEMENT EXECUTE FUNCTION presence_legacy_guard_write();
CREATE TRIGGER presence_legacy_history_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
    ON presence_replacement_history FOR EACH STATEMENT EXECUTE FUNCTION presence_legacy_guard_write();

-- No application code invokes this function. A future account registry must
-- call it in the same transaction as its own activation, after security review.
CREATE FUNCTION presence_freeze_empty_legacy() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Ordinary writes conflict with these locks. Retain both through commit.
    LOCK TABLE presence_replacement_scopes, presence_replacement_history IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM presence_replacement_scopes) OR
       EXISTS (SELECT 1 FROM presence_replacement_history) THEN
        RAISE EXCEPTION 'legacy presence registry is not empty';
    END IF;
    UPDATE presence_legacy_cutover_guard SET frozen = TRUE WHERE singleton;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing legacy guard'; END IF;
END $$;
