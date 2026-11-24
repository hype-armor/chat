# Username reservation migration deployment

Migration `0020_username_legacy_coordination.sql` requires a maintenance window.
Do not use a rolling deployment across this migration.

1. Stop every server instance and every other writer of `accounts` or
   `username_reservations`. Drain or terminate their in-flight transactions using
   the normal operational procedure. Keep writes stopped through the migration.
2. Apply all pending migrations as one controlled deployment. If reconciliation
   reports a conflict with a permanent reservation, stop and investigate. Do not
   delete or reassign the reservation to make the migration pass.
3. Start only the new server version. Do not restart an old server against the
   migrated database, including during rollback. A binary rollback requires a
   separately designed safe procedure; removing the trigger would allow retired
   names to be reused.

The maintenance window is necessary for two reasons. The migration locks
`accounts` before `username_reservations`, while new registration writes them in
the opposite order. A concurrent registration can deadlock with the migration.
Changing the lock order alone does not solve this for old account-first writers.

The trigger rejects a retired name with a unique violation before an old
`INSERT INTO accounts ... ON CONFLICT (username) DO NOTHING` can handle it.
The old binary returns HTTP 500 rather than 409. The same applies to some current
name collisions. This fails closed: the name is not assigned. A trigger cannot
make that old statement return its expected conflict result for a retired name
without an account row for it. Creating such ghost accounts, or weakening the
permanent reservation, is not an acceptable workaround.
