"""Synthetic fixtures only; no systemd, Docker, or production effects."""
import copy
import unittest

from permanent_startup_barrier_testonly import BarrierError, PermanentBarrier


class Fake:
    def __init__(self):
        self.dropin = self.loaded = False
        self.marker = self.journal = self.lease = None
        self.inventory = {'app', 'worker'}
        self.proofs = {}
        self.external = True
        self.uncertain = False
        self.fail = None
        self.on_migrate = lambda: None
        self.migrations = 0
        self.claimed = set()
        self.runtime_proofs = {('op1', 'old_ready', 'old'), ('op1', 'committed', 'new')}
        self.release_proofs = {('op1', 'old_ready', 'old', 'boundary'),
                               ('op1', 'committed', 'new', 'boundary_committed')}
        self.effect_started = self.capture_started = False
        self.on_remove = lambda: None
        self.absence_verified = True
        self.writers_running = False

    def install_dropin(self): self.dropin = True
    def verify_durable_dropin(self): return self.dropin
    def reload(self): self.loaded = self.dropin
    def verify_loaded_condition(self): return self.loaded
    def needs_reconciliation(self): return self.uncertain
    def require_reconciliation(self): self.uncertain = True
    def read_journal(self): return copy.deepcopy(self.journal)
    def write_journal(self, op, phase, fields):
        self.journal = dict(operation=op, phase=phase, **fields)
        if self.fail == 'journal': raise OSError('uncertain journal')
    def claim_operation(self, op):
        if op in self.claimed: raise ValueError('operation reused')
        self.claimed.add(op)
    def verify_no_effect_or_capture(self, op):
        return not self.effect_started and not self.capture_started
    def publish_marker(self, op):
        self.marker = op
        if self.fail == 'marker': raise OSError('uncertain marker')
    def verify_marker(self, op): return self.marker == op
    def acquire_fence(self, op, inventory):
        self.writers_running = False  # Fresh quiescence, including after reboot.
        self.lease = op
        self.proofs = {writer: op for writer in inventory}
    def verify_fence(self, op, inventory):
        return (self.lease == op and self.external and self.inventory == set(inventory)
                and self.proofs == {writer: op for writer in inventory})
    def migrate(self, op, runtime):
        self.effect_started = True
        self.runtime_proofs.discard((op, 'old_ready', runtime))
        self.migrations += 1
        self.on_migrate()
        if self.fail == 'migrate': raise OSError('uncertain migration')
    def rollback(self, op, runtime):
        if self.fail == 'rollback': raise OSError('uncertain rollback')
        self.runtime_proofs.add((op, 'old_ready', runtime))
    def verify_runtime(self, op, boundary, runtime):
        return (op, boundary, runtime) in self.runtime_proofs
    def verify_release_safe(self, op, boundary, runtime, phase):
        return (op, boundary, runtime, phase) in self.release_proofs
    def release_marker_fenced(self, op, inventory, boundary, runtime, phase):
        self.on_remove()
        if not (self.verify_marker(op) and self.verify_fence(op, inventory)
                and self.verify_runtime(op, boundary, runtime)
                and self.verify_release_safe(op, boundary, runtime, phase)):
            raise ValueError('atomic release precondition failed')
        self.marker = None
        if self.fail == 'release': raise OSError('uncertain removal')
    def verify_durable_marker_absence(self, op):
        return self.marker is None and self.absence_verified
    def reboot(self):
        other = copy.deepcopy(self)
        other.loaded = other.dropin
        other.lease = None
        # Only the pre-marker, pre-effect state permits old writers on reboot.
        other.writers_running = (other.marker is None and other.journal is not None
                                 and other.journal['phase'] == 'preparing'
                                 and other.verify_no_effect_or_capture(other.journal['operation']))
        return other


class Crash(Exception): pass


def crash_at(target):
    def checkpoint(name):
        if name == target: raise Crash(name)
    return checkpoint


class BarrierTests(unittest.TestCase):
    def ready(self, boundary='old_ready', runtime='old'):
        fake = Fake()
        barrier = PermanentBarrier(fake)
        barrier.provision()
        barrier.acquire('op1', ['app', 'worker'])
        barrier.persist_boundary('op1', boundary, runtime)
        return fake, barrier

    def test_requires_provision_and_preserves_dropin(self):
        fake = Fake()
        barrier = PermanentBarrier(fake)
        with self.assertRaises(BarrierError): barrier.acquire('op1', ['app'])
        fake, barrier = self.ready()
        barrier.release('op1', 'old_ready', 'old')
        self.assertTrue(fake.dropin)
        self.assertIsNone(fake.marker)

    def test_migration_requires_operation_boundary_and_runtime(self):
        for args in [('old', 'old_ready', 'old'), ('op1', 'committed', 'old'),
                     ('op1', 'old_ready', 'new')]:
            fake, barrier = self.ready()
            with self.assertRaises(BarrierError): barrier.migrate(*args)
            self.assertEqual(fake.migrations, 0)
        fake, barrier = self.ready()
        with self.assertRaises(BarrierError): barrier.finish_migration('op1', 'new')
        barrier.migrate('op1', 'old_ready', 'old')
        barrier.finish_migration('op1', 'new')
        barrier.release('op1', 'committed', 'new')

    def test_release_requires_exact_safe_runtime(self):
        fake, barrier = self.ready()
        for args in [('op2', 'old_ready', 'old'), ('op1', 'committed', 'new'),
                     ('op1', 'old_ready', 'new')]:
            with self.assertRaises(BarrierError): barrier.release(*args)
        self.assertEqual(fake.marker, 'op1')
        barrier.migrate('op1', 'old_ready', 'old')
        with self.assertRaises(BarrierError): barrier.release('op1', 'old_ready', 'old')

    def test_inventory_and_stale_proofs_fail_closed(self):
        for change in ('missing', 'new', 'changed', 'stale', 'lease', 'external'):
            fake, barrier = self.ready()
            if change == 'missing': fake.inventory.remove('worker')
            if change == 'new': fake.inventory.add('new')
            if change == 'changed': fake.inventory = {'app', 'replacement'}
            if change == 'stale': fake.proofs['worker'] = 'op0'
            if change == 'lease': fake.lease = 'op0'
            if change == 'external': fake.external = False
            with self.subTest(change=change), self.assertRaises(BarrierError):
                barrier.migrate('op1', 'old_ready', 'old')
            self.assertEqual(fake.migrations, 0)

    def test_reboot_does_not_restore_volatile_lease(self):
        fake, _ = self.ready()
        rebooted = fake.reboot()
        with self.assertRaises(BarrierError):
            PermanentBarrier(rebooted).migrate('op1', 'old_ready', 'old')
        self.assertEqual(rebooted.marker, 'op1')
        self.assertEqual(rebooted.journal['phase'], 'boundary')

    def test_incomplete_acquisition_never_authorizes_effects(self):
        for point in ('journal_preparing', 'marker_published', 'writer_policies_fenced'):
            fake = Fake()
            barrier = PermanentBarrier(fake, crash_at(point))
            barrier.provision()
            with self.assertRaises(Crash): barrier.acquire('op1', ['app', 'worker'])
            resumed = PermanentBarrier(fake.reboot())
            with self.assertRaises(BarrierError): resumed.migrate('op1', 'old_ready', 'old')
            with self.assertRaises(BarrierError): resumed.acquire('op1', ['app', 'worker'])

    def test_uncertain_effects_and_removal_crash_require_reconciliation(self):
        for failure in ('journal', 'marker', 'migrate', 'release'):
            fake = Fake()
            barrier = PermanentBarrier(fake)
            barrier.provision()
            if failure in ('journal', 'marker'):
                fake.fail = failure
                with self.assertRaises(BarrierError): barrier.acquire('op1', ['app', 'worker'])
            else:
                fake, barrier = self.ready()
                fake.fail = failure
                with self.assertRaises(BarrierError):
                    (barrier.migrate if failure == 'migrate' else barrier.release)('op1', 'old_ready', 'old')
            self.assertTrue(fake.uncertain)
            with self.assertRaises(BarrierError): PermanentBarrier(fake.reboot()).acquire('op2', ['app'])
        fake, _ = self.ready()
        with self.assertRaises(Crash):
            PermanentBarrier(fake, crash_at('marker_released')).release('op1', 'old_ready', 'old')
        with self.assertRaises(BarrierError):
            PermanentBarrier(fake.reboot()).release('op1', 'old_ready', 'old')
        self.assertEqual(fake.journal['phase'], 'releasing')

    def test_rollback_and_committed_recovery_boundaries(self):
        fake, barrier = self.ready()
        barrier.migrate('op1', 'old_ready', 'old')
        barrier.rollback('op1', 'old')
        barrier.release('op1', 'old_ready', 'old')
        self.assertIsNone(fake.marker)
        fake, barrier = self.ready()
        barrier.migrate('op1', 'old_ready', 'old')
        barrier.finish_migration('op1', 'new')
        barrier.release('op1', 'committed', 'new')
        self.assertIsNone(fake.marker)

    def test_preparing_reboot_requires_fresh_quiescence(self):
        fake = Fake()
        barrier = PermanentBarrier(fake, crash_at('journal_preparing'))
        barrier.provision()
        with self.assertRaises(Crash): barrier.acquire('op1', ['app', 'worker'])
        rebooted = fake.reboot()
        self.assertTrue(rebooted.writers_running)
        PermanentBarrier(rebooted).resume_preparing('op1')
        self.assertFalse(rebooted.writers_running)
        self.assertEqual(rebooted.journal['phase'], 'fenced')
        for flag in ('effect_started', 'capture_started'):
            rebooted = fake.reboot()
            setattr(rebooted, flag, True)
            with self.assertRaises(BarrierError): PermanentBarrier(rebooted).resume_preparing('op1')

    def test_operation_unique_and_stale_runtime_release_proofs(self):
        fake, barrier = self.ready()
        barrier.release('op1', 'old_ready', 'old')
        fake.journal = None  # Simulate external journal archival, not ID reuse.
        with self.assertRaises(BarrierError): barrier.acquire('op1', ['app', 'worker'])
        for proof in ('runtime_proofs', 'release_proofs'):
            fake, barrier = self.ready()
            setattr(fake, proof, {('op0', 'old_ready', 'old', 'boundary')} if proof == 'release_proofs'
                    else {('op0', 'old_ready', 'old')})
            with self.assertRaises(BarrierError): barrier.release('op1', 'old_ready', 'old')
            self.assertEqual(fake.marker, 'op1')

    def test_atomic_removal_detects_drift_and_ambiguity(self):
        for change in ('runtime', 'release', 'lease', 'inventory'):
            fake, barrier = self.ready()
            def drift():
                if change == 'runtime': fake.runtime_proofs.clear()
                if change == 'release': fake.release_proofs.clear()
                if change == 'lease': fake.lease = None
                if change == 'inventory': fake.inventory.add('new')
            fake.on_remove = drift
            with self.subTest(change=change), self.assertRaises(BarrierError):
                barrier.release('op1', 'old_ready', 'old')
            self.assertEqual(fake.marker, 'op1')
            self.assertTrue(fake.uncertain)
        fake, barrier = self.ready()
        fake.absence_verified = False
        with self.assertRaises(BarrierError): barrier.release('op1', 'old_ready', 'old')
        self.assertTrue(fake.uncertain)
        self.assertEqual(fake.journal['phase'], 'releasing')

    def test_fence_loss_during_migration_is_detected(self):
        fake, barrier = self.ready()
        fake.on_migrate = lambda: setattr(fake, 'lease', None)
        with self.assertRaises(BarrierError): barrier.migrate('op1', 'old_ready', 'old')
        self.assertEqual(fake.journal['phase'], 'migrating')
        self.assertEqual(fake.marker, 'op1')


if __name__ == '__main__': unittest.main()
