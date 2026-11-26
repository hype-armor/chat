"""Synthetic integration only: fake Docker, disposable data, no operational authorization.

The existing recovery fixture supplies synthetic evidence and policy checks. The
ordered fence is connected to its locked coordinator for each test run.
"""
import hashlib
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import test_username_migration_recovery_coordinator_integration_testonly as fixture
from username_migration_ordered_fence_testonly import FakeDocker, FakeGate, OrderedFakeFence


class OrderedCoordinatorE2E(unittest.TestCase):
    def exercise(self, scenario=None):
        original_run = fixture.SyntheticCoordinator.run
        observed = []
        services = {'app': 'a' * 64, 'worker': 'b' * 64, 'db': 'c' * 64}
        roles = [('app', 'writer'), ('worker', 'writer'), ('db', 'storage')]
        order = ['app', 'worker', 'db']
        raw = json.dumps({'services': {'app': {'depends_on': ['db']}, 'worker': {}, 'db': {}}}).encode()
        runner = FakeDocker(services, 'db')
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        fd = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)

        class FenceStopped(Exception):
            pass

        def run(coordinator, operation):
            backend = coordinator.backend
            if True:
                try:
                    anchor = (operation, hashlib.sha256(raw).hexdigest(), (), tuple(roles), 'db', tuple(order))
                    wrapper = OrderedFakeFence(journal_fd=fd, config_bytes=raw, operation=operation,
                        profiles=[], classifications=roles, postgres='db', explicit_order=order[:],
                        verify_anchor=lambda *args: args == anchor, services=services,
                        gates=[FakeGate(operation)], runner=runner, clean_drain_services={'app', 'worker'})
                    capture, fence = backend.capture, backend.fence
                    verify, migrate = backend.verify_recovery_set, backend.migrate
                    start, ingress = backend.start_new, backend.open_new
                    def build_then_capture():
                        observed.append('build')  # Synthetic callback, not an image build.
                        capture()
                    def ordered_fence():
                        observed.append('fence')
                        wrapper.engage()
                        fence()
                    def checked_verify():
                        verify()
                        observed.append('verified')
                    def checked_migrate():
                        observed.append('migrate')
                        migrate()
                    def private_start():
                        observed.append('private_start')
                        start()
                    def committed_ingress():
                        self.assertEqual(coordinator.journal.load()['phase'], 'committed')
                        observed.append('ingress')
                        ingress()
                    backend.capture, backend.fence = build_then_capture, ordered_fence
                    backend.verify_recovery_set, backend.migrate = checked_verify, checked_migrate
                    backend.start_new, backend.open_new = private_start, committed_ingress
                    if scenario == 'order':
                        wrapper.explicit_order = ['worker', 'app', 'db']
                    if scenario == 'unclean':
                        runner.rows[services['app']]['State']['ExitCode'] = 1
                    if scenario in ('order', 'unclean'):
                        with self.assertRaises(Exception):
                            original_run(coordinator, operation)
                        self.assertNotIn('migrate', observed)
                        self.assertNotIn('ingress', observed)
                        self.assertNotIn(services['db'], self.stops(runner))
                        if scenario == 'order':
                            self.assertEqual(runner.calls, [])
                        self.assertEqual(coordinator.journal.load()['phase'], 'rollback')
                        raise FenceStopped()
                    return original_run(coordinator, operation)
                finally:
                    pass
        with patch.object(fixture.SyntheticCoordinator, 'run', run):
            case = fixture.Integration()
            if scenario == 'corrupt':
                case.exercise(change='postgres', when='before_migrate')
            elif scenario == 'rollback':
                case.exercise(change='postgres', when='before_commit')
            elif scenario == 'ingress':
                case.exercise(post_commit=True)
            elif scenario in ('order', 'unclean'):
                with self.assertRaises(FenceStopped):
                    case.exercise()
            else:
                case.exercise()
        self.assertEqual(observed[0:2], ['build', 'fence'])
        if scenario not in ('order', 'unclean'):
            self.assertEqual(self.stops(runner)[:3], [services[x] for x in order])
        if scenario in (None, 'ingress'):
            self.assertLess(observed.index('verified'), observed.index('migrate'))
            self.assertLess(observed.index('migrate'), observed.index('private_start'))
            self.assertLess(observed.index('private_start'), observed.index('ingress'))

    @staticmethod
    def stops(runner):
        return [call[-1] for call in runner.calls if call[3:5] == ['container', 'stop']]

    def test_complete(self): self.exercise()
    def test_changed_order(self): self.exercise('order')
    def test_unclean_writer(self): self.exercise('unclean')
    def test_corrupted_backup(self): self.exercise('corrupt')
    def test_rollback_before_cutover(self): self.exercise('rollback')
    def test_post_commit_ingress_failure(self): self.exercise('ingress')


if __name__ == '__main__':
    unittest.main()
