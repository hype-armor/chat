import os
import unittest
from unittest.mock import patch

from permanent_gate_fs_testonly import FakeManager, Fixture, Gate, GateError


class GateTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.manager = FakeManager()
        self.evidence = {'operation': 'op', 'phase': 'old_ready', 'runtime': 'r',
                         'runtime_compatible': True, 'writers': ['writer'],
                         'continuous_fence': True, 'fence_id': 'fence-1'}
        self.gate = Gate(self.fixture, self.manager, evidence=lambda op: self.evidence)

    def crash(self, point):
        def checkpoint(name):
            if name == point:
                raise RuntimeError('lost reply')
        return Gate(self.fixture, self.manager, checkpoint, evidence=lambda op: self.evidence)

    def test_release_keeps_dropin_and_needs_boundary(self):
        self.gate.provision()
        self.gate.acquire('op')
        with self.assertRaises((GateError, FileNotFoundError)):
            self.gate.release('op', 'old_ready', 'r')
        self.gate.boundary('op', 'old_ready', 'r')
        with self.assertRaises(GateError):
            self.gate.release('op', 'old_ready', 'other')
        self.gate.release('op', 'old_ready', 'r')
        self.assertTrue(os.path.isfile(os.path.join(self.fixture.path, 'drop-in')))
        self.assertFalse(os.path.exists(os.path.join(self.fixture.path, 'marker')))

    def test_crash_install_and_reload_fail_closed(self):
        with self.assertRaises(RuntimeError):
            self.crash('drop_created').provision()
        with self.assertRaises(FileExistsError):
            self.gate.provision()

    def test_crash_reload_fails_closed(self):
        with self.assertRaises(RuntimeError):
            self.crash('manager_reloaded').provision()
        with self.assertRaises(FileExistsError):
            self.gate.provision()

    def test_crash_marker_fails_closed(self):
        self.gate.provision()
        with self.assertRaises(RuntimeError):
            self.crash('marker_created').acquire('op')
        with self.assertRaises(GateError):
            self.gate.acquire('op')
        with self.assertRaises(FileNotFoundError):
            self.gate.boundary('op', 'old_ready', 'r')

    def test_crash_removal_is_not_successful_retry(self):
        self.gate.provision()
        self.gate.acquire('op')
        self.evidence['phase'] = 'committed'
        self.gate.boundary('op', 'committed', 'r')
        with self.assertRaises(RuntimeError):
            self.crash('marker_unlinked').release('op', 'committed', 'r')
        with self.assertRaises(FileNotFoundError):
            self.gate.release('op', 'committed', 'r')

    def test_changed_marker_dropin_and_manager_rejected(self):
        self.gate.provision()
        self.gate.acquire('op')
        self.gate.boundary('op', 'old_ready', 'r')
        self.manager.loaded = None
        with self.assertRaises(GateError):
            self.gate.release('op', 'old_ready', 'r')
        self.manager.loaded = self.gate.condition
        os.unlink('marker', dir_fd=self.fixture.fd)
        os.symlink('/etc/passwd', 'marker', dir_fd=self.fixture.fd)
        with self.assertRaises(OSError):
            self.gate.release('op', 'old_ready', 'r')
        os.unlink('drop-in', dir_fd=self.fixture.fd)
        with open(os.path.join(self.fixture.path, 'drop-in'), 'wb') as f:
            f.write(self.gate.drop)
        os.chmod(os.path.join(self.fixture.path, 'drop-in'), 0o600)
        with self.assertRaises(GateError):
            self.gate.provision()

    def test_external_evidence_is_required_and_bound(self):
        self.gate.provision()
        self.gate.acquire('op')
        missing = Gate(self.fixture, self.manager)
        with self.assertRaises(GateError):
            missing.boundary('op', 'old_ready', 'r')
        for key, value in [('operation', 'other'), ('phase', 'committed'),
                           ('runtime_compatible', False), ('writers', []),
                           ('continuous_fence', False), ('fence_id', '')]:
            old = self.evidence[key]
            self.evidence[key] = value
            with self.assertRaises(GateError):
                self.gate.boundary('op', 'old_ready', 'r')
            self.evidence[key] = old
        self.gate.boundary('op', 'old_ready', 'r')
        self.evidence['fence_id'] = 'different'
        with self.assertRaises(GateError):
            self.gate.release('op', 'old_ready', 'r')
        self.assertTrue(os.path.exists(os.path.join(self.fixture.path, 'marker')))

    def test_interrupted_release_reopen_and_second_operation(self):
        self.gate.provision()
        self.gate.acquire('op')
        self.gate.boundary('op', 'old_ready', 'r')
        with self.assertRaises(RuntimeError):
            self.crash('marker_unlinked').release('op', 'old_ready', 'r')
        reopened = Gate(self.fixture, self.manager, evidence=lambda op: self.evidence)
        self.assertEqual(reopened.reconcile(), 'uncertain')
        before = set(os.listdir(self.fixture.path))
        with self.assertRaises(GateError):
            reopened.acquire('other')
        self.assertEqual(before, set(os.listdir(self.fixture.path)))
        self.assertFalse(os.path.exists(os.path.join(self.fixture.path, 'marker')))

    def test_release_intent_and_synced_removal_lost_reply(self):
        for point in ('release_intent_recorded', 'marker_removal_synced'):
            with self.subTest(point=point):
                fixture = Fixture()
                try:
                    gate = Gate(fixture, self.manager, evidence=lambda op: self.evidence)
                    gate.provision()
                    gate.acquire('op')
                    gate.boundary('op', 'old_ready', 'r')
                    def checkpoint(name):
                        if name == point:
                            raise RuntimeError('lost reply')
                    with self.assertRaises(RuntimeError):
                        Gate(fixture, self.manager, checkpoint, lambda op: self.evidence).release('op', 'old_ready', 'r')
                    self.assertEqual(gate.reconcile(), 'uncertain')
                finally:
                    fixture.close()

    def test_lost_directory_fsync_and_stale_proof(self):
        self.gate.provision()
        self.gate.acquire('op')
        self.gate.boundary('op', 'old_ready', 'r')
        real_fsync = os.fsync
        unlinked = [False]
        def checkpoint(name):
            if name == 'marker_unlinked':
                unlinked[0] = True
        def fsync(fd):
            if unlinked[0] and fd == self.fixture.fd:
                raise OSError('lost fsync')
            return real_fsync(fd)
        with patch('permanent_gate_fs_testonly.os.fsync', side_effect=fsync):
            with self.assertRaises(OSError):
                Gate(self.fixture, self.manager, checkpoint, lambda op: self.evidence).release('op', 'old_ready', 'r')
        self.assertEqual(self.gate.reconcile(), 'uncertain')
        before = {}
        for name in os.listdir(self.fixture.path):
            with open(os.path.join(self.fixture.path, name), 'rb') as stream:
                before[name] = stream.read()
        with self.assertRaises(GateError):
            self.gate.acquire('second')
        for name, data in before.items():
            with open(os.path.join(self.fixture.path, name), 'rb') as stream:
                self.assertEqual(stream.read(), data)
        self.assertFalse(os.path.exists(os.path.join(self.fixture.path, 'marker')))

    def test_evidence_callback_drift_fails_closed(self):
        for action in ('boundary', 'release-first', 'release-second'):
            for drift in ('manager', 'drop', 'marker'):
                with self.subTest(action=action, drift=drift):
                    fixture = Fixture()
                    manager = FakeManager()
                    try:
                        gate = Gate(fixture, manager, evidence=lambda op: self.evidence)
                        gate.provision()
                        gate.acquire('op')
                        if action != 'boundary':
                            gate.boundary('op', 'old_ready', 'r')
                        calls = [0]
                        def evidence(op):
                            calls[0] += 1
                            if calls[0] == (2 if action == 'release-second' else 1):
                                if drift == 'manager':
                                    manager.loaded = None
                                else:
                                    name = 'drop-in' if drift == 'drop' else 'marker'
                                    os.unlink(name, dir_fd=fixture.fd)
                                    gate._create(name, gate.drop if drift == 'drop' else b'op')
                            return self.evidence
                        gate.evidence = evidence
                        with self.assertRaises((GateError, OSError)):
                            if action == 'boundary':
                                gate.boundary('op', 'old_ready', 'r')
                            else:
                                gate.release('op', 'old_ready', 'r')
                        self.assertTrue(os.path.exists(os.path.join(fixture.path, 'marker')))
                        if action == 'boundary':
                            self.assertFalse(os.path.exists(os.path.join(fixture.path, 'boundary-proof')))
                    finally:
                        fixture.close()

    def test_reconcile_rejects_equal_malformed_or_stale_records(self):
        for bad in (None, {}, {'operation': 'op'}, 'invalid', []):
            with self.subTest(bad=bad):
                fixture = Fixture()
                try:
                    gate = Gate(fixture, FakeManager(), evidence=lambda op: self.evidence)
                    gate.provision()
                    gate.acquire('op')
                    gate.boundary('op', 'old_ready', 'r')
                    gate._record('release-intent', bad)
                    gate._record('release-proof', bad)
                    os.unlink('marker', dir_fd=fixture.fd)
                    with self.assertRaises(GateError):
                        gate.reconcile()
                finally:
                    fixture.close()
        self.gate.provision()
        self.gate.acquire('op')
        self.gate.boundary('op', 'old_ready', 'r')
        record = self.gate._get('boundary-proof')
        record['runtime'] = 'stale'
        record['evidence']['runtime'] = 'stale'
        self.gate._record('release-intent', record)
        self.gate._record('release-proof', record)
        os.unlink('marker', dir_fd=self.fixture.fd)
        with self.assertRaises(GateError):
            self.gate.reconcile()

    def test_no_arbitrary_roots_or_runner(self):
        with self.assertRaises(GateError):
            Gate('/etc/systemd/system', self.manager)
        with self.assertRaises(GateError):
            Gate(self.fixture, object())


if __name__ == '__main__':
    unittest.main()
