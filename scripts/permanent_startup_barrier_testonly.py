"""Synthetic startup barrier model. This is not an operational adapter.

The backend must provide atomic, durable journal and marker observations, and a
continuous exclusive fence lease. An uncertain write or removal requires external
reconciliation. This model does not implement systemd, Docker, or a real fence.

The synthetic pre_migration_old_runtime boundary is not the real journal's
old_ready phase. The latter is an irreversible post-restore boundary: restore
must never run after it. This model does not represent that journal phase.
"""


class BarrierError(RuntimeError):
    """A safety proof is missing or an effect has an uncertain outcome."""


class PermanentBarrier:
    def __init__(self, backend, checkpoint=lambda name: None):
        self.backend = backend
        self.checkpoint = checkpoint

    def provision(self):
        self.backend.install_dropin()
        self.checkpoint('dropin_installed')
        if not self.backend.verify_durable_dropin():
            raise BarrierError('drop-in is not durable')
        self.backend.reload()
        self.checkpoint('reloaded')
        self._barrier()

    def _barrier(self):
        if not self.backend.verify_durable_dropin() or not self.backend.verify_loaded_condition():
            raise BarrierError('permanent startup condition is not verified')

    def _write(self, action):
        # A failed write can have reached durable storage. Do not retry it here.
        try:
            action()
        except Exception as exc:
            self.backend.require_reconciliation()
            raise BarrierError('ambiguous effect requires external reconciliation') from exc

    def _journal(self, op, phase, **fields):
        self._write(lambda: self.backend.write_journal(op, phase, fields))
        self.checkpoint('journal_' + phase)

    def _record(self, op, phases):
        record = self.backend.read_journal()
        if (self.backend.needs_reconciliation() or not record or
                record['operation'] != op or record['phase'] not in phases):
            raise BarrierError('journal operation or phase is not verified')
        return record

    def acquire(self, op, inventory):
        if not op or not inventory or len(set(inventory)) != len(inventory):
            raise BarrierError('operation and unique nonempty inventory required')
        self._barrier()
        if self.backend.needs_reconciliation() or self.backend.read_journal() is not None:
            raise BarrierError('existing or uncertain operation requires reconciliation')
        inventory = tuple(sorted(inventory))
        # The backend durably rejects every previously claimed operation ID.
        self._write(lambda: self.backend.claim_operation(op))
        self._journal(op, 'preparing', inventory=inventory)
        self._write(lambda: self.backend.publish_marker(op))
        self.checkpoint('marker_published')
        self.backend.acquire_fence(op, inventory)
        self.checkpoint('writer_policies_fenced')
        self._verify(op, inventory)
        self._journal(op, 'fenced', inventory=inventory)

    def resume_preparing(self, op):
        """Restart acquisition after reboot; old writers may have run before the marker.

        The backend must prove no migration or recovery capture started. Fence
        acquisition must freshly quiesce all writers, including restarted ones.
        """
        record = self._record(op, {'preparing'})
        inventory = record['inventory']
        self._barrier()
        if not self.backend.verify_no_effect_or_capture(op):
            raise BarrierError('pre-marker recovery is not safe')
        if not self.backend.verify_marker(op):
            if not self.backend.verify_durable_marker_absence(op):
                raise BarrierError('marker state is not verified')
            self._write(lambda: self.backend.publish_marker(op))
        self.backend.acquire_fence(op, inventory)
        self._verify(op, inventory)
        self._journal(op, 'fenced', inventory=inventory)

    def _verify(self, op, inventory):
        self._barrier()
        if self.backend.needs_reconciliation():
            raise BarrierError('external reconciliation required')
        if not self.backend.verify_marker(op):
            raise BarrierError('marker is not verified for operation')
        if not self.backend.verify_fence(op, inventory):
            raise BarrierError('continuous fence or writer inventory is not verified')

    def persist_boundary(self, op, boundary, runtime):
        record = self._record(op, {'fenced'})
        if (boundary != 'pre_migration_old_runtime' or not runtime or
                not self.backend.verify_runtime(op, boundary, runtime)):
            raise BarrierError('boundary and compatible runtime identity required')
        inventory = record['inventory']
        self._verify(op, inventory)
        self._journal(op, 'boundary', inventory=inventory, boundary=boundary, runtime=runtime)
        self._verify(op, inventory)

    def migrate(self, op, boundary, runtime):
        record = self._record(op, {'boundary'})
        if (boundary != 'pre_migration_old_runtime' or record['boundary'] != boundary or
                record['runtime'] != runtime or not self.backend.verify_runtime(op, boundary, runtime)):
            raise BarrierError('migration requires matching pre_migration_old_runtime runtime')
        inventory = record['inventory']
        self._verify(op, inventory)
        self._journal(op, 'migrating', inventory=inventory, boundary=boundary, runtime=runtime)
        self._verify(op, inventory)
        self._write(lambda: self.backend.migrate(op, runtime))
        self._verify(op, inventory)
        self._journal(op, 'migrated', inventory=inventory, boundary=boundary, runtime=runtime)

    def finish_migration(self, op, runtime):
        record = self._record(op, {'migrated'})
        inventory = record['inventory']
        self._verify(op, inventory)
        if not runtime or not self.backend.verify_runtime(op, 'committed', runtime):
            raise BarrierError('committed runtime proof required')
        self._journal(op, 'boundary_committed', inventory=inventory,
                      boundary='committed', runtime=runtime)

    def rollback(self, op, runtime):
        record = self._record(op, {'migrated'})
        inventory = record['inventory']
        self._verify(op, inventory)
        self._journal(op, 'rolling_back', inventory=inventory)
        self._verify(op, inventory)
        self._write(lambda: self.backend.rollback(op, runtime))
        self._verify(op, inventory)
        if not self.backend.verify_runtime(op, 'pre_migration_old_runtime', runtime):
            raise BarrierError('rollback runtime proof required')
        self._journal(op, 'boundary', inventory=inventory, boundary='pre_migration_old_runtime', runtime=runtime)

    def release(self, op, boundary, runtime):
        record = self._record(op, {'boundary', 'boundary_committed'})
        if (record['boundary'] != boundary or record['runtime'] != runtime or
                boundary not in ('pre_migration_old_runtime', 'committed') or
                not self.backend.verify_runtime(op, boundary, runtime) or
                not self.backend.verify_release_safe(op, boundary, runtime, record['phase'])):
            raise BarrierError('release boundary or runtime is not safe')
        inventory = record['inventory']
        self._verify(op, inventory)
        self._journal(op, 'releasing', inventory=inventory, boundary=boundary, runtime=runtime)
        self._verify(op, inventory)
        if (not self.backend.verify_runtime(op, boundary, runtime) or
                not self.backend.verify_release_safe(op, boundary, runtime, record['phase'])):
            raise BarrierError('release proof changed before removal')
        # This trusted backend effect atomically rechecks the fence, inventory,
        # runtime and release proof with removal. Exceptions are ambiguous.
        self._write(lambda: self.backend.release_marker_fenced(op, inventory, boundary, runtime, record['phase']))
        if not self.backend.verify_durable_marker_absence(op):
            self.backend.require_reconciliation()
            raise BarrierError('marker absence is not durable or is ambiguous')
        self.checkpoint('marker_released')
        self._verify_release_fence(op, inventory)
        self._journal(op, 'released', inventory=inventory, boundary=boundary, runtime=runtime)

    def _verify_release_fence(self, op, inventory):
        self._barrier()
        if self.backend.needs_reconciliation() or not self.backend.verify_fence(op, inventory):
            raise BarrierError('fence lost during release')
