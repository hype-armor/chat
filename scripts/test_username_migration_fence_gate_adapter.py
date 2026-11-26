import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import uuid

from username_migration_fence_gate_adapter import AdapterError, SyntheticFreshIntent, TestGateAdapter
import username_migration_docker_fence as docker_fence
from username_migration_docker_fence import DockerFence, FenceError
from test_username_migration_docker_fence import Daemon, container
from username_migration_systemd_gate import GateError, SystemdGate
from username_migration_update_gate import UpdateGate, UpdateGateError

spec = importlib.util.spec_from_file_location('journal', Path(__file__).with_name('username-migration-journal.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ('journal', 'fence', 'update', 'state', 'unit'):
            (self.root / name).mkdir(mode=0o700)
        self.ufd = os.open(self.root / 'update', os.O_RDONLY | os.O_DIRECTORY)
        self.ffd = os.open(self.root / 'fence', os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.ufd)
        self.addCleanup(os.close, self.ffd)
        self.op = str(uuid.uuid4())
        self.marker = self.root / 'state' / 'marker'
        self.dropin = self.root / 'unit' / 'gate.conf'
        self.dropin.write_text('[Unit]\nConditionPathExists=!' + str(self.marker) + '\n')
        self.calls = []
        self.fail = False

    def manager(self, args):
        self.calls.append(args)
        if self.fail and self.marker.exists():
            raise OSError('lost response after marker publication')
        return ('LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n'
                f'DropInPaths={self.dropin}\nConditions={{ type=ConditionPathExists ; '
                f'trigger=no ; negate=yes ; path={self.marker} ; state=failed }}\n')

    def adapter(self, journal, op=None):
        op = op or self.op
        return TestGateAdapter(journal, self.ffd, UpdateGate(self.ufd, op),
            SystemdGate(op, runner=self.manager, marker=str(self.marker),
                        dropin=str(self.dropin), trusted_root=str(self.root)))

    def fresh(self, adapter):
        return adapter.engage_initial(fresh_intent=SyntheticFreshIntent(self.op))

    def test_initial_and_restart_recovery(self):
        with module.Journal(self.root / 'journal') as journal:
            journal.begin(self.op)
            journal.advance('fence')
            self.fail = True
            with self.assertRaisesRegex(GateError, 'Gate engagement failed'):
                self.fresh(self.adapter(journal))
            self.assertTrue((self.root / 'update' / UpdateGate.MARKER).exists())
            self.assertTrue(self.marker.exists())
        self.fail = False
        with module.Journal(self.root / 'journal') as journal:
            adapter = self.adapter(journal)
            adapter.engage(resume=True)
            self.assertTrue(adapter.verify())
            # Synthetic intent exercises this adapter only; it is not fence authorization.
            container_id = 'a' * 64
            intent = {
                'version': docker_fence.DOCKER_FENCE_INTENT_VERSION,
                'operation_id': self.op, 'project': 'chat',
                'services': {'db': container_id}, 'database': 'db',
                'inventory': {'container_ids': [container_id], 'volumes': {}, 'protected_mounts': {}},
                'networks': ['chat_net'],
                'policies': {container_id: {'Name': 'no', 'MaximumRetryCount': 0}},
                'stop_order': ['db'], 'clean_drain_services': [],
                'drain_initially_running': [],
            }
            path = self.root / 'fence' / 'docker-fence.json'
            path.write_text(json.dumps(intent))
            path.chmod(0o600)
            self.assertTrue(adapter.verify())
            self.marker.unlink()
            with mock.patch.object(adapter, '_verify_docker_intent', wraps=adapter._verify_docker_intent) as validate:
                with self.assertRaisesRegex(GateError, 'Gate verification failed'):
                    adapter.engage(resume=True)
                validate.assert_called_once_with()
            self.assertFalse(self.marker.exists())
        self.assertTrue(all(x == ['daemon-reload'] or x[0] == 'show' for x in self.calls))

    def test_rollback_recovers_partial_gates_before_docker_intent(self):
        with module.Journal(self.root / 'journal') as journal:
            journal.begin(self.op)
            journal.advance('fence')
            self.fail = True
            with self.assertRaisesRegex(GateError, 'Gate engagement failed'):
                self.fresh(self.adapter(journal))
            journal.begin_rollback()
        self.fail = False
        with module.Journal(self.root / 'journal') as journal:
            adapter = self.adapter(journal)
            with self.assertRaisesRegex(AdapterError, 'operation journal mismatch or invalid phase'):
                self.fresh(adapter)
            adapter.engage(resume=True)
            self.assertTrue(adapter.verify())

    def test_reject_mismatch_and_release_only_old_ready(self):
        with module.Journal(self.root / 'journal') as journal:
            journal.begin(self.op)
            journal.advance('fence')
            adapter = self.adapter(journal)
            self.fresh(adapter)
            with self.assertRaises(AdapterError):
                self.fresh(self.adapter(journal, str(uuid.uuid4())))
            with self.assertRaises(AdapterError):
                adapter.clear_old_ready()
            journal.begin_rollback()
            with self.assertRaises(AdapterError):
                adapter.clear_old_ready()
            self.assertTrue(self.marker.exists())
            journal.advance('old_ready')
            markers = (self.root / 'update' / UpdateGate.MARKER, self.marker)
            before = [(p.read_bytes(), p.stat().st_dev, p.stat().st_ino) for p in markers]
            # The release protocol is unsupported without trusted durable authority.
            with mock.patch.object(adapter.systemd, 'clear_old_ready') as systemd_clear:
                with self.assertRaisesRegex(UpdateGateError, 'automatic release disabled'):
                    adapter.clear_old_ready()
                systemd_clear.assert_not_called()
            self.assertEqual(before, [(p.read_bytes(), p.stat().st_dev, p.stat().st_ino) for p in markers])
        with module.Journal(self.root / 'journal') as journal:
            with self.assertRaisesRegex(UpdateGateError, 'automatic release disabled'):
                self.adapter(journal).clear_old_ready()
            self.assertEqual(before, [(p.read_bytes(), p.stat().st_dev, p.stat().st_ino) for p in markers])
            self.assertTrue(self.dropin.exists())
            with self.assertRaises(AdapterError):
                self.adapter(journal).engage_initial()

    def test_composed_fence_interruption_and_binding(self):
        ids = {'db': 'c' * 64, 'server': 'a' * 64}
        daemon = Daemon([container(ids['db'], 'db', 'pg'), container(ids['server'], 'server')])
        with module.Journal(self.root / 'journal') as journal:
            journal.begin(self.op)
            journal.advance('fence')
            adapter = self.adapter(journal)
            def make(fd, operation=None):
                return DockerFence(fd, 'chat', ids, 'db', {'pg'}, {'chat_net'}, 'db',
                                   [adapter], daemon, operation_id=operation or self.op, stop_order=['server', 'db'],
                                   clean_drain_services={'server'})
            with self.assertRaises(FenceError):
                make(self.ufd)
            with self.assertRaises(FenceError):
                make(self.ffd, str(uuid.uuid4()))
            fence = make(self.ffd)
            # DockerFence cannot supply fresh intent or distinguish recovery.
            with self.assertRaises(FenceError):
                fence.engage()
            self.assertFalse(self.marker.exists())
            self.fresh(adapter)
            with self.assertRaises(FenceError):
                fence.engage()
            self.assertTrue(self.marker.exists())
            self.assertFalse(any(c[3:5] in (['container', 'update'], ['container', 'stop']) for c in daemon.calls))

    def test_composed_fence_rejects_foreign_and_legacy_intent(self):
        ids = {'db': 'c' * 64, 'server': 'a' * 64}
        daemon = Daemon([container(ids['db'], 'db', 'pg'), container(ids['server'], 'server')])
        with module.Journal(self.root / 'journal') as journal:
            journal.begin(self.op)
            journal.advance('fence')
            adapter = self.adapter(journal)
            fence = DockerFence(self.ffd, 'chat', ids, 'db', {'pg'}, {'chat_net'}, 'db',
                                [adapter], daemon, operation_id=self.op, stop_order=['server', 'db'],
                                clean_drain_services={'server'})
            self.fresh(adapter)
            # This mock supplies the coordinator step only for intent tests.
            with mock.patch.object(adapter, 'engage_initial'):
                fence.engage()
            self.assertTrue(adapter.verify())
            path = self.root / 'fence' / 'docker-fence.json'
            data = json.loads(path.read_text())
            data['operation_id'] = str(uuid.uuid4())
            path.write_text(json.dumps(data))
            before = len(daemon.calls)
            with self.assertRaises(FenceError):
                fence.engage()
            self.assertEqual(len(daemon.calls), before)
            data.pop('operation_id')
            data['version'] = 1
            path.write_text(json.dumps(data))
            with self.assertRaises(AdapterError):
                adapter.verify()

    def test_fresh_proof_and_missing_recovery_marker(self):
        with module.Journal(self.root / 'journal') as journal:
            journal.begin(self.op)
            journal.advance('fence')
            adapter = self.adapter(journal)
            with self.assertRaises(AdapterError):
                adapter.engage_initial()
            with self.assertRaisesRegex(GateError, 'Marker missing; publication outcome is ambiguous'):
                adapter.engage(resume=True)
            self.assertFalse(self.marker.exists())
            self.assertFalse((self.root / 'update' / UpdateGate.MARKER).exists())
            proof = SyntheticFreshIntent(self.op)
            with mock.patch('username_migration_fence_gate_adapter.os.getpid', return_value=proof.pid + 1):
                with self.assertRaises(AdapterError):
                    adapter.engage_initial(fresh_intent=proof)
            adapter.engage_initial(fresh_intent=proof)
            with self.assertRaises(AdapterError):
                adapter.engage_initial(fresh_intent=proof)
            self.marker.unlink()
            with self.assertRaisesRegex(GateError, 'Marker missing; publication outcome is ambiguous'):
                adapter.engage(resume=True)
            self.assertFalse(self.marker.exists())

    def test_preexisting_foreign_marker_rejected(self):
        with module.Journal(self.root / 'journal') as journal:
            journal.begin(self.op)
            journal.advance('fence')
            (self.root / 'update' / UpdateGate.MARKER).write_text(str(uuid.uuid4()) + '\n')
            with self.assertRaisesRegex(UpdateGateError, 'unexpected marker'):
                self.fresh(self.adapter(journal))
            self.assertFalse(self.marker.exists())


if __name__ == '__main__':
    unittest.main()
