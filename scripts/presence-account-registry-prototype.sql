-- Test-only prototype. Callers must not have direct table access in a real system.
-- A single mutex serializes every mutation, including grant changes and recovery.
-- This is intentionally conservative and is not a production authorization design.
CREATE TABLE mutex (id int PRIMARY KEY CHECK (id = 1));
INSERT INTO mutex VALUES (1);
CREATE TABLE accounts (id text PRIMARY KEY CHECK (octet_length(id) BETWEEN 1 AND 128), epoch int NOT NULL DEFAULT 0 CHECK(epoch >= 0));
CREATE TABLE devices (account text REFERENCES accounts, id text CHECK(octet_length(id) BETWEEN 1 AND 128), PRIMARY KEY(account,id));
CREATE TABLE audience (account text REFERENCES accounts, recipient text CHECK(octet_length(recipient) BETWEEN 1 AND 128), generation int NOT NULL CHECK(generation > 0), selected boolean NOT NULL, active_group text, PRIMARY KEY(account,recipient), CHECK(selected OR active_group IS NULL));
CREATE TABLE used_groups (account text REFERENCES accounts, group_id text CHECK(octet_length(group_id) BETWEEN 1 AND 128), PRIMARY KEY(account,group_id));
CREATE TABLE operations (account text REFERENCES accounts, op text CHECK(octet_length(op) BETWEEN 1 AND 128), device text NOT NULL, epoch int NOT NULL, recipient text NOT NULL, expected int NOT NULL, selected boolean NOT NULL, group_id text, PRIMARY KEY(account,op));
CREATE FUNCTION lock_registry() RETURNS void LANGUAGE sql AS $$ SELECT 1 FROM mutex WHERE id=1 FOR UPDATE $$;
CREATE FUNCTION activate(a text,d text, verified_empty_legacy boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM lock_registry();
 IF verified_empty_legacy IS DISTINCT FROM true OR (SELECT count(*) FROM accounts)>=2 THEN RAISE EXCEPTION 'activation prohibited'; END IF;
 INSERT INTO accounts(id) VALUES(a); INSERT INTO devices VALUES(a,d);
END $$;
CREATE FUNCTION enroll(a text,d text,e int) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM lock_registry();
 IF NOT EXISTS (SELECT 1 FROM accounts WHERE id=a AND epoch=e) THEN RAISE EXCEPTION 'stale epoch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM devices WHERE account=a AND id=d) AND (SELECT count(*) FROM devices WHERE account=a)>=3 THEN RAISE EXCEPTION 'device limit'; END IF;
 INSERT INTO devices VALUES(a,d) ON CONFLICT DO NOTHING;
END $$;
-- The boolean is a test stub, not proof of authoritative recovery.
CREATE FUNCTION recover(a text,d text, authoritative boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM lock_registry();
 IF authoritative IS DISTINCT FROM true THEN RAISE EXCEPTION 'recovery not authorized'; END IF;
 UPDATE accounts SET epoch=epoch+1 WHERE id=a; IF NOT FOUND THEN RAISE EXCEPTION 'unknown account'; END IF;
 DELETE FROM devices WHERE account=a; INSERT INTO devices VALUES(a,d);
 UPDATE audience SET active_group=NULL WHERE account=a;
END $$;
CREATE FUNCTION change_grant(a text,d text,e int,r text,ex int,o text,s boolean,g text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE cur audience%ROWTYPE; prev operations%ROWTYPE; gen int;
BEGIN
 PERFORM lock_registry();
 IF a IS NULL OR d IS NULL OR r IS NULL OR o IS NULL OR e IS NULL OR ex IS NULL OR s IS NULL OR octet_length(a) NOT BETWEEN 1 AND 128 OR octet_length(d) NOT BETWEEN 1 AND 128 OR octet_length(r) NOT BETWEEN 1 AND 128 OR octet_length(o) NOT BETWEEN 1 AND 128 OR (g IS NOT NULL AND octet_length(g) NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'invalid identifier'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounts JOIN devices ON devices.account=accounts.id WHERE accounts.id=a AND accounts.epoch=e AND devices.id=d) THEN RAISE EXCEPTION 'stale device'; END IF;
 IF s IS DISTINCT FROM (g IS NOT NULL) THEN RAISE EXCEPTION 'invalid selection'; END IF;
 SELECT * INTO cur FROM audience WHERE account=a AND recipient=r;
 gen := COALESCE(cur.generation,0);
 SELECT * INTO prev FROM operations WHERE account=a AND op=o;
 IF FOUND THEN
   IF (prev.device,prev.epoch,prev.recipient,prev.expected,prev.selected,prev.group_id) IS DISTINCT FROM (d,e,r,ex,s,g) OR (gen,cur.selected,cur.active_group) IS DISTINCT FROM (ex+1,s,g) THEN RAISE EXCEPTION 'operation reused or superseded'; END IF;
   RETURN gen;
 END IF;
 IF ex<>gen THEN RAISE EXCEPTION 'generation conflict'; END IF;
 IF gen=0 AND (SELECT count(*) FROM audience WHERE account=a)>=2 THEN RAISE EXCEPTION 'audience limit'; END IF;
 IF (SELECT count(*) FROM operations WHERE account=a)>=8 OR (SELECT count(*) FROM operations)>=12 THEN RAISE EXCEPTION 'operation limit'; END IF;
 IF s THEN
   IF (SELECT count(*) FROM used_groups WHERE account=a)>=4 OR (SELECT count(*) FROM used_groups)>=6 THEN RAISE EXCEPTION 'group limit'; END IF;
   INSERT INTO used_groups VALUES(a,g);
 END IF;
 INSERT INTO audience VALUES(a,r,ex+1,s,g) ON CONFLICT(account,recipient) DO UPDATE SET generation=EXCLUDED.generation,selected=EXCLUDED.selected,active_group=EXCLUDED.active_group;
 INSERT INTO operations VALUES(a,o,d,e,r,ex,s,g);
 RETURN ex+1;
END $$;
