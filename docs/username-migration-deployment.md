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

## Writer fence and recovery gates

The tracked migration orchestrator refuses operational execution. A successful
restore or application restart does not make it safe to open the gate.

- In normal service, PostgreSQL must retain its configured TCP access. During
  maintenance, isolate both stores, not just the web proxy. Cover direct SQL,
  S3, SeaweedFS administration, background tasks, bots, and volume access.
  Bind the operation to the exact storage and runtime identities. Stop on
  unknown topology or incomplete drain. Credential rotation alone does not end
  existing SQL sessions or block unauthenticated storage endpoints.
- Keep a persistent startup gate independent of the migration controller. A
  controller crash must not start old writers or leave a worker that can still
  write while recovery is running. Treat uncertain Docker daemon effects as
  unresolved until independently reconciled.
- Before `committed`, keep external ingress closed. After `committed`, never
  restore the old backup or restart old writers. To roll back before commit,
  restore both stores and verify them before recording `old_ready`. In the
  coordinator protocol, record `old_ready` durably before old application
  startup or writer credential exposure. After `old_ready`, never restore
  again. Do not confuse this with the separate old-release adapter protocol.

The opt-in `python3 scripts/test_migration_maintenance_namespace.py --run-disposable`
check uses synthetic listeners in a private Linux network and PID namespace.
It verifies that the observer cannot use the maintenance listener and that
killing the namespace controller also stops a detached worker. It does not
exercise the Docker daemon, real stores, host power loss, or production fencing.

For the separate, opt-in disposable Docker exercise and reboot check, see the
[Compose writer-fence rehearsal](username-migration-compose-rehearsal.md).
