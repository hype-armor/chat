#!/usr/bin/env python3
"""Fake-backend intent tests only. The release protocol is unsupported.

The preflight bypass below tests coordinator intent, not a safe deployment or
proof that automatic gate release works. No real service is contacted.
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import uuid

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('components', HERE / 'username-migration-orchestrator-components.py')
components = importlib.util.module_from_spec(spec)
spec.loader.exec_module(components)


class TestOnlyOrchestrator(components.Orchestrator):
    def _preflight(self):
        pass


class FakeBackend:
    def __init__(self, failure=None):
        self.events = []
        self.failure = failure
        self.counts = {}

    def __getattr__(self, name):
        def action():
            self.events.append(name)
            self.counts[name] = self.counts.get(name, 0) + 1
            if self.failure == (name, self.counts[name]):
                raise RuntimeError('injected ' + name)
        return action


class SyntheticWorkflowTest(unittest.TestCase):
    def journal(self, directory):
        return components._journal.Journal(directory)

    def test_production_preflight_blocks_run_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory, self.journal(directory) as journal:
            backend = FakeBackend()
            orchestrator = components.Orchestrator(journal, backend)
            with self.assertRaises(components.Unavailable):
                orchestrator.run(str(uuid.uuid4()))
            with self.assertRaises(components.Unavailable):
                orchestrator.recover()
            self.assertIsNone(journal.load())
            self.assertEqual(backend.events, [])

    def test_forward_faults_preserve_rollback_intent_and_propagate(self):
        # The last journal transition is intentionally rejected: automatic
        # release is unsupported, even with a fake backend.
        cases = [('capture', 1, False), ('fence', 1, False),
                 ('backup', 1, False), ('verify_recovery_set', 1, False),
                 ('migrate', 1, True), ('start_new', 1, True),
                 ('verify_recovery_set', 2, True)]
        for method, occurrence, restore_required in cases:
            with self.subTest(method=method, occurrence=occurrence), tempfile.TemporaryDirectory() as directory:
                with self.journal(directory) as journal:
                    backend = FakeBackend((method, occurrence))
                    with self.assertRaisesRegex(components._journal.JournalError, 'invalid or irreversible'):
                        TestOnlyOrchestrator(journal, backend).run(str(uuid.uuid4()))
                    self.assertEqual(journal.load()['phase'], 'old_ready')
                    self.assertEqual(journal.load()['restore_required'], restore_required)
                    self.assertEqual('verify_and_restore' in backend.events, restore_required)
                    self.assertNotIn('open_new', backend.events)
                    self.assertLess(backend.events.index('restore_old_runtime'), backend.events.index('start_old_and_check'))

    def test_recovery_fault_propagates_without_release(self):
        with tempfile.TemporaryDirectory() as directory, self.journal(directory) as journal:
            journal.begin(str(uuid.uuid4()))
            for phase in ('fence', 'backup', 'migrate'):
                journal.advance(phase)
            backend = FakeBackend(('verify_and_restore', 1))
            with self.assertRaisesRegex(RuntimeError, 'injected verify_and_restore'):
                TestOnlyOrchestrator(journal, backend).recover()
            self.assertEqual(journal.load()['phase'], 'rollback')
            self.assertEqual(backend.events, ['fence', 'verify_and_restore'])

    def test_old_ready_retry_never_restores_and_release_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, self.journal(directory) as journal:
            journal.begin(str(uuid.uuid4()))
            for phase in ('fence', 'backup', 'migrate'):
                journal.advance(phase)
            journal.begin_rollback()
            journal.advance('old_ready')
            self.assertEqual(journal.recovery_decision(), 'resume_old')
            backend = FakeBackend(('start_old_and_check', 1))
            orchestrator = TestOnlyOrchestrator(journal, backend)
            with self.assertRaisesRegex(RuntimeError, 'injected start_old_and_check'):
                orchestrator.recover()
            self.assertEqual(journal.load()['phase'], 'old_ready')
            with self.assertRaisesRegex(components._journal.JournalError, 'invalid or irreversible'):
                orchestrator.recover()
            self.assertEqual(journal.load()['phase'], 'old_ready')
            self.assertNotIn('verify_and_restore', backend.events)
            self.assertEqual(backend.events, ['start_old_and_check', 'start_old_and_check', 'open_old'])

    def test_post_commit_failure_propagates_without_restore(self):
        with tempfile.TemporaryDirectory() as directory, self.journal(directory) as journal:
            backend = FakeBackend(('open_new', 1))
            orchestrator = TestOnlyOrchestrator(journal, backend)
            with self.assertRaisesRegex(RuntimeError, 'injected open_new'):
                orchestrator.run(str(uuid.uuid4()))
            self.assertEqual(journal.load()['phase'], 'committed')
            self.assertEqual(journal.recovery_decision(), 'leave_new')
            before = list(backend.events)
            orchestrator.recover()
            self.assertEqual(backend.events, before)
            self.assertNotIn('verify_and_restore', backend.events)
            self.assertNotIn('start_old_and_check', backend.events)


if __name__ == '__main__':
    unittest.main()
