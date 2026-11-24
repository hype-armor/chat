-- Deployment requires all account and reservation writers to be stopped and
-- their transactions drained before this migration. Old servers must not resume
-- afterward. See docs/username-migration-deployment.md. The locks fence writes
-- during reconciliation, but do not make a rolling migration deadlock-free.
LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE username_reservations IN ACCESS EXCLUSIVE MODE;

-- An old server may have deleted an account without releasing its current name.
DELETE FROM username_reservations r
WHERE NOT r.retired AND NOT EXISTS (
    SELECT 1 FROM accounts a WHERE a.username = r.username AND a.account_id = r.account_id
);
-- A conflict with a retired name indicates an unrecoverable pre-migration
-- violation. Fail closed rather than silently discard the permanent reservation.
INSERT INTO username_reservations (username, account_id)
SELECT a.username, a.account_id FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM username_reservations r WHERE r.username = a.username);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM accounts a JOIN username_reservations r USING (username)
               WHERE r.retired OR r.account_id <> a.account_id) THEN
        RAISE EXCEPTION 'account username conflicts with a permanent reservation';
    END IF;
END $$;

CREATE FUNCTION coordinate_account_username() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    owner_id UUID;
    is_retired BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM username_reservations
        WHERE username = OLD.username AND account_id = OLD.account_id AND NOT retired;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.username = OLD.username AND NEW.account_id = OLD.account_id THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.account_id <> OLD.account_id THEN
        RAISE EXCEPTION 'account identity cannot change';
    END IF;

    -- New servers already insert this row. Old servers rely on this trigger.
    INSERT INTO username_reservations (username, account_id)
    VALUES (NEW.username, NEW.account_id) ON CONFLICT (username) DO NOTHING;
    SELECT account_id, retired INTO owner_id, is_retired
    FROM username_reservations WHERE username = NEW.username FOR UPDATE;
    IF owner_id IS DISTINCT FROM NEW.account_id OR is_retired IS DISTINCT FROM FALSE THEN
        RAISE unique_violation USING MESSAGE = 'that username is taken',
            CONSTRAINT = 'username_reservations_pkey';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        -- This is idempotent with the new server's explicit retirement.
        UPDATE username_reservations SET retired = TRUE
        WHERE username = OLD.username AND account_id = OLD.account_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'current username reservation is missing';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER accounts_username_coordination
BEFORE INSERT OR UPDATE OF username, account_id OR DELETE ON accounts
FOR EACH ROW EXECUTE FUNCTION coordinate_account_username();
