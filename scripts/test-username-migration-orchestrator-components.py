import importlib.util
import subprocess
import tempfile
import unittest
import uuid
from unittest import mock
from pathlib import Path

spec = importlib.util.spec_from_file_location('components', Path(__file__).with_name('username-migration-orchestrator-components.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Backend:
    def __init__(self, fail=None):
        self.events = []
        self.fail = fail

    def __getattr__(self, name):
        def call():
            self.events.append(name)
            if name == self.fail:
                self.fail = None
                raise RuntimeError(name)
        return call


class Crash(BaseException):
    pass


class CrashBackend:
    """Disposable model. Every effect checks its persisted intent first."""
    phases = {
        'capture': ('capture',), 'fence': ('fence', 'rollback'),
        'backup': ('backup',), 'migrate': ('migrate',),
        'start_new': ('start_new',), 'verify_recovery_set': ('backup', 'start_new'),
        'open_new': ('committed',),
        'verify_and_restore': ('rollback',), 'restore_old_runtime': ('rollback',),
        'start_old_and_check': ('old_ready',), 'open_old': ('old_ready',),
    }

    def __init__(self, journal, crash=None):
        self.journal = journal
        self.crash = crash
        self.events = []
        self.mutations = []

    def __getattr__(self, name):
        if name not in self.phases:
            raise AttributeError(name)
        def call():
            phase = self.journal.load()['phase']
            if phase not in self.phases[name]:
                raise AssertionError((name, phase))
            self.events.append((name, phase))
            if self.crash in ((name, 'before'), (name, phase, 'before')):
                self.crash = None
                raise Crash()
            self.mutations.append(name)
            if self.crash in ((name, 'after'), (name, phase, 'after')):
                self.crash = None
                raise Crash()
        return call


class EnabledForTests(m.Orchestrator):
    # Fake-only inspection of incomplete code. Release protocol is unsupported.
    def _preflight(self):
        pass


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.op = str(uuid.uuid4())

    def test_entry_fails_before_effects(self):
        with m._journal.Journal(self.temp.name) as journal:
            backend = Backend()
            with self.assertRaises(m.Unavailable):
                m.Orchestrator(journal, backend).run(self.op)
            with self.assertRaises(m.Unavailable):
                m.Orchestrator(journal, backend).recover()
            self.assertIsNone(journal.load())
            self.assertEqual(backend.events, [])

    def test_failure_each_forward_phase(self):
        for phase in ('capture', 'fence', 'backup', 'migrate', 'start_new', 'verify_recovery_set', 'open_new'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                with m._journal.Journal(directory) as journal:
                    backend = Backend(phase)
                    expected = RuntimeError if phase == 'open_new' else m.Unavailable
                    with self.assertRaises(expected) as raised:
                        EnabledForTests(journal, backend).run(self.op)
                    if phase != 'open_new':
                        self.assertIsInstance(raised.exception.__context__, RuntimeError)
                        self.assertEqual(str(raised.exception.__context__), phase)
                    state = journal.load()
                    if phase == 'open_new':
                        self.assertEqual(state['phase'], 'committed')
                        self.assertNotIn('verify_and_restore', backend.events)
                        self.assertNotIn('open_old', backend.events)
                    else:
                        self.assertEqual(state['phase'], 'old_ready')
                        self.assertEqual('verify_and_restore' in backend.events, phase in ('migrate', 'start_new'))
                        self.assertEqual(backend.events[-1], 'restore_old_runtime')

    def test_missing_or_changed_recovery_evidence_prevents_commit(self):
        for problem in ('missing', 'changed'):
            with self.subTest(problem=problem), tempfile.TemporaryDirectory() as directory:
                with m._journal.Journal(directory) as journal:
                    class EvidenceBackend(Backend):
                        def verify_recovery_set(self):
                            self.events.append('verify_recovery_set')
                            if journal.load()['phase'] == 'start_new':
                                raise ValueError(problem + ' recovery evidence')
                    backend = EvidenceBackend()
                    with self.assertRaises(m.Unavailable) as raised:
                        EnabledForTests(journal, backend).run(self.op)
                    self.assertIsInstance(raised.exception.__context__, ValueError)
                    self.assertIn(problem, str(raised.exception.__context__))
                    self.assertEqual(journal.load()['phase'], 'old_ready')
                    self.assertEqual(backend.events, [
                        'capture', 'fence', 'backup', 'verify_recovery_set', 'migrate', 'start_new',
                        'verify_recovery_set', 'fence', 'verify_and_restore',
                        'restore_old_runtime'])
                    self.assertNotIn('open_new', backend.events)

    def test_failed_first_verification_recovers_without_migration_or_restore(self):
        with m._journal.Journal(self.temp.name) as journal:
            backend = CrashBackend(journal)
            def fail_verification():
                self.assertEqual(journal.load()['phase'], 'backup')
                backend.events.append(('verify_recovery_set', 'backup'))
                raise RuntimeError('bad recovery evidence')
            backend.verify_recovery_set = fail_verification
            with self.assertRaises(m.Unavailable) as raised:
                EnabledForTests(journal, backend).run(self.op)
            self.assertIsInstance(raised.exception.__context__, RuntimeError)
            self.assertEqual(str(raised.exception.__context__), 'bad recovery evidence')
            self.assertEqual(journal.load()['phase'], 'old_ready')
            self.assertEqual(backend.events, [
                ('capture', 'capture'), ('fence', 'fence'), ('backup', 'backup'),
                ('verify_recovery_set', 'backup'), ('fence', 'rollback'),
                ('restore_old_runtime', 'rollback')])

    def test_crash_resume_each_intent(self):
        for phase in ('capture', 'fence', 'backup', 'migrate', 'start_new', 'committed'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                with m._journal.Journal(directory) as journal:
                    journal.begin(self.op)
                    for next_phase in ('fence', 'backup', 'migrate', 'start_new', 'committed'):
                        if journal.load()['phase'] == phase:
                            break
                        journal.advance(next_phase)
                with m._journal.Journal(directory) as journal:
                    backend = Backend()
                    if phase == 'committed':
                        EnabledForTests(journal, backend).recover()
                        self.assertEqual(backend.events, [])
                    else:
                        with self.assertRaises(m.Unavailable):
                            EnabledForTests(journal, backend).recover()
                        self.assertEqual(journal.load()['phase'], 'old_ready')
                        self.assertEqual('verify_and_restore' in backend.events, phase in ('migrate', 'start_new'))

    def test_recovery_exceptions_preserve_journal_and_evidence(self):
        for restore_required, methods in (
            (False, ('fence', 'restore_old_runtime')),
            (True, ('fence', 'verify_and_restore', 'restore_old_runtime')),
        ):
            for failed_method in methods:
                with self.subTest(restore_required=restore_required, method=failed_method), tempfile.TemporaryDirectory() as directory:
                    evidence = Path(directory) / 'evidence'
                    evidence.write_bytes(b'original recovery evidence')
                    with m._journal.Journal(directory) as journal:
                        journal.begin(self.op)
                        for phase in ('fence', 'backup'):
                            journal.advance(phase)
                        if restore_required:
                            journal.advance('migrate')
                        backend = Backend(failed_method)
                        with self.assertRaisesRegex(RuntimeError, '^' + failed_method + '$'):
                            EnabledForTests(journal, backend).recover()
                        state = journal.load()
                        self.assertEqual(state, {'version': 1, 'operation_id': self.op,
                                                 'phase': 'rollback', 'restore_required': restore_required})
                        expected = ['fence']
                        if restore_required:
                            expected.append('verify_and_restore')
                        expected.append('restore_old_runtime')
                        self.assertEqual(backend.events, expected[:expected.index(failed_method) + 1])
                        self.assertEqual(evidence.read_bytes(), b'original recovery evidence')
                    with m._journal.Journal(directory) as journal:
                        self.assertEqual(journal.load(), state)
                        with self.assertRaises(m.Unavailable):
                            EnabledForTests(journal, backend).recover()
                        self.assertEqual(journal.load()['phase'], 'old_ready')
                        self.assertEqual(evidence.read_bytes(), b'original recovery evidence')
                        events = list(backend.events)
                        with self.assertRaises(m.Unavailable):
                            EnabledForTests(journal, backend).recover()
                        self.assertEqual(backend.events, events)
                        self.assertEqual(evidence.read_bytes(), b'original recovery evidence')

    def test_old_ready_retry_never_restores(self):
        with m._journal.Journal(self.temp.name) as journal:
            journal.begin(self.op)
            journal.advance('fence')
            journal.advance('backup')
            journal.advance('migrate')
            journal.begin_rollback()
            journal.advance('old_ready')
        with m._journal.Journal(self.temp.name) as journal:
            backend = Backend()
            for _ in range(2):
                with self.assertRaisesRegex(m.Unavailable, 'unresolved.*gate release'):
                    EnabledForTests(journal, backend).recover()
                self.assertEqual(journal.load()['phase'], 'old_ready')
            self.assertEqual(backend.events, [])
            self.assertNotIn('verify_and_restore', backend.events)

    def test_legacy_rolled_back_is_unresolved_without_effects(self):
        for restore_required in (False, True):
            with self.subTest(restore_required=restore_required), tempfile.TemporaryDirectory() as directory:
                with m._journal.Journal(directory) as journal:
                    state = {'version': 1, 'operation_id': self.op, 'phase': 'rolled_back',
                             'restore_required': restore_required}
                    journal._save(state)
                    backend = Backend()
                    for _ in range(2):
                        with self.assertRaisesRegex(m.Unavailable, 'unresolved.*gate release'):
                            EnabledForTests(journal, backend).recover()
                        self.assertEqual(journal.load(), state)
                        self.assertEqual(backend.events, [])

    def test_crash_before_and_after_all_effects(self):
        forward = ('capture', 'fence', 'backup', 'migrate', 'start_new',
                   ('verify_recovery_set', 'backup'), ('verify_recovery_set', 'start_new'), 'open_new')
        recovery = ('fence', 'verify_and_restore', 'restore_old_runtime')
        for stage, names in (('forward', forward), ('recovery', recovery)):
            for name in names:
                for timing in ('before', 'after'):
                    with self.subTest(stage=stage, effect=name, timing=timing), tempfile.TemporaryDirectory() as directory:
                        with m._journal.Journal(directory) as journal:
                            crash = (*name, timing) if isinstance(name, tuple) else (name, timing)
                            backend = CrashBackend(journal, crash)
                            coordinator = EnabledForTests(journal, backend)
                            if stage == 'recovery':
                                journal.begin(self.op)
                                for phase in ('fence', 'backup', 'migrate'):
                                    journal.advance(phase)
                                journal.begin_rollback()
                            with self.assertRaises(Crash):
                                (coordinator.run(self.op) if stage == 'forward' else coordinator.recover())
                            crashed_phase = journal.load()['phase']
                        with m._journal.Journal(directory) as journal:
                            backend.journal = journal
                            before = len(backend.events)
                            coordinator = EnabledForTests(journal, backend)
                            if crashed_phase == 'committed':
                                coordinator.recover()
                                after = len(backend.events)
                                coordinator.recover()
                                self.assertEqual(len(backend.events), after)
                            else:
                                with self.assertRaises(m.Unavailable):
                                    coordinator.recover()
                            phase = journal.load()['phase']
                            self.assertEqual(phase, 'committed' if crashed_phase == 'committed' else 'old_ready')
                            resumed = [event[0] for event in backend.events[before:]]
                            self.assertNotIn('start_new', resumed)
                            self.assertNotIn('open_new', resumed)
                            if stage == 'forward' and name == ('verify_recovery_set', 'backup'):
                                self.assertNotIn('migrate', backend.mutations)
                                self.assertNotIn('verify_and_restore', resumed)
                                self.assertEqual(resumed, ['fence', 'restore_old_runtime'])
                            if crashed_phase == 'old_ready':
                                self.assertEqual(resumed, [])
                            if crashed_phase == 'committed':
                                self.assertEqual(resumed, [])

    def test_terminal_states_never_change_or_restart(self):
        for target in ('committed', 'complete'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                with m._journal.Journal(directory) as journal:
                    journal.begin(self.op)
                    for phase in ('fence', 'backup', 'migrate', 'start_new', 'committed'):
                        journal.advance(phase)
                    if target == 'complete':
                        journal.advance('complete')
                    original = journal.load()
                    backend = CrashBackend(journal)
                    for _ in range(3):
                        EnabledForTests(journal, backend).recover()
                    self.assertEqual(journal.load(), original)
                    self.assertEqual(backend.events, [])

    def test_fsync_failure_stops_effects_at_every_forward_and_recovery_sync(self):
        # Sweep every fsync, including file and directory syncs after replacement.
        # Each fresh run has one injected failure and no real backend.
        for recovery in (False, True):
            reached_end = False
            for fail_at in range(1, 100):
                with self.subTest(recovery=recovery, fsync=fail_at), tempfile.TemporaryDirectory() as directory:
                    with m._journal.Journal(directory) as journal:
                        if recovery:
                            journal.begin(self.op)
                            for phase in ('fence', 'backup', 'migrate'):
                                journal.advance(phase)
                        backend = CrashBackend(journal)
                        real_fsync = m._journal.os.fsync
                        calls = [0]
                        events_at_failure = []
                        def fsync(fd):
                            calls[0] += 1
                            if calls[0] == fail_at:
                                events_at_failure.append(list(backend.events))
                                raise OSError('injected uncertain fsync')
                            return real_fsync(fd)
                        with mock.patch.object(m._journal.os, 'fsync', side_effect=fsync):
                            try:
                                coordinator = EnabledForTests(journal, backend)
                                coordinator.recover() if recovery else coordinator.run(self.op)
                            except OSError:
                                self.assertTrue(journal.failed)
                                self.assertEqual(backend.events, events_at_failure[0])
                            except m.Unavailable:
                                # Recovery reaches the unsupported release transition.
                                self.assertTrue(recovery)
                                self.assertLess(calls[0], fail_at)
                                reached_end = True
                            else:
                                self.assertFalse(recovery)
                                self.assertLess(calls[0], fail_at)
                                reached_end = True
                    if not reached_end:
                        with m._journal.Journal(directory) as reopened:
                            backend.journal = reopened
                            state = reopened.load()
                            before = len(backend.events)
                            coordinator = EnabledForTests(reopened, backend)
                            if state is None or state['phase'] in ('committed', 'complete'):
                                coordinator.recover()
                                self.assertEqual(len(backend.events), before)
                                coordinator.recover()
                                self.assertEqual(len(backend.events), before)
                            else:
                                with self.assertRaises(m.Unavailable):
                                    coordinator.recover()
                                self.assertEqual(reopened.load()['phase'], 'old_ready')
                                count = len(backend.events)
                                with self.assertRaises(m.Unavailable):
                                    coordinator.recover()
                                resumed = [event[0] for event in backend.events[count:]]
                                self.assertNotIn('verify_and_restore', resumed)
                                self.assertEqual(resumed, [])
                    if reached_end:
                        break
            self.assertTrue(reached_end)

    def test_success_opens_ingress_only_after_commit(self):
        with m._journal.Journal(self.temp.name) as journal:
            backend = CrashBackend(journal)
            coordinator = EnabledForTests(journal, backend)
            coordinator.run(self.op)
            self.assertEqual(backend.events, [
                ('capture', 'capture'), ('fence', 'fence'), ('backup', 'backup'),
                ('verify_recovery_set', 'backup'), ('migrate', 'migrate'), ('start_new', 'start_new'),
                ('verify_recovery_set', 'start_new'), ('open_new', 'committed')])
            self.assertEqual(journal.load()['phase'], 'complete')
            coordinator.recover()
            self.assertEqual(len(backend.events), 8)

    def test_pins_and_rejects_changed_pin(self):
        image = 'sha256:' + 'a' * 64
        pins = {}
        def run(args, **kwargs):
            self.assertEqual(args[:3], ['docker', '--host', 'unix:///var/run/docker.sock'])
            self.assertEqual(kwargs['env']['DOCKER_CONFIG'], '/nonexistent')
            if args[3:5] == ['image', 'inspect']:
                ref = args[-1]
                if ref.startswith('chat-migration-evidence:') and ref not in pins:
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 0, pins.get(ref, image) + '\n')
            if args[3:5] == ['image', 'tag']:
                pins[args[-1]] = args[-2]
            return subprocess.CompletedProcess(args, 0, '')
        adapter = m.DockerImages(run)
        manifest = adapter.capture_and_pin(self.op, {'server': 'old:latest'})
        self.assertEqual(manifest['server']['id'], image)
        adapter.capture_and_pin(self.op, {'server': 'old:latest'})
        pins[manifest['server']['pin']] = 'sha256:' + 'b' * 64
        with self.assertRaises(ValueError):
            adapter.capture_and_pin(self.op, {'server': 'old:latest'})


if __name__ == '__main__':
    unittest.main()
