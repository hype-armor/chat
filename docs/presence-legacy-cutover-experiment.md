# Experimental legacy presence cutover

Account-scoped registry activation remains unavailable. No route invokes the
cutover or enables presence. Migration `0023_presence_legacy_cutover_guard.sql`
adds a default-off guard. It does not inspect existing data, freeze writes, or
delete history during startup. It can be applied when legacy inventory is not
empty.

The internal `presence_freeze_empty_legacy()` function locks both `0022` tables
before checking either table. It freezes legacy writes only when both tables are
globally empty. The locks remain until transaction commit. Statement triggers
reject later legacy inserts, updates, deletes, and truncates. A rollback leaves
legacy writes enabled. The check includes orphaned scope and history rows. It
does not delete or migrate any row. A future registry must call this function
in the same transaction as activation, after the complete design is reviewed.

This fence assumes an honest server and database owner, and no database rollback.
A database owner can change the guard, function, or triggers and bypass it. It
is not a defense against a malicious owner or database rollback. No new privilege
boundary is claimed.

`scripts/test-presence-legacy-cutover-postgres.py` applies the actual migration
in an isolated PostgreSQL cluster. It tests nonempty migration, empty cutover,
orphan inventory, rollback, and both concurrent write orderings. The separate
account registry prototype uses stubs. There is no integrated account-scoped
store or authoritative recovery and regrant implementation. Authentication,
recovery, grant ordering, replay retention, and activation remain unresolved.
The guarded cutover alone is not sufficient to enable presence.
