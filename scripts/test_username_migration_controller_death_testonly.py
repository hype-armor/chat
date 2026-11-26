"""Real controller process death with private, synthetic writer state.

Each runner is a fresh interpreter. The journal uses real filesystem calls;
only the chosen call can fail or kill the runner. SQLite stands in for durable
backend effects. This does not simulate host power loss or a physical fence.
"""
from contextlib import closing
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import signal
import sqlite3
import stat
import tempfile
import unittest
from unittest import mock
import uuid

spec = importlib.util.spec_from_file_location(
    'components', Path(__file__).with_name('username-migration-orchestrator-components.py'))
components = importlib.util.module_from_spec(spec)
spec.loader.exec_module(components)

SYNC_ERROR = 23
RELEASE_DISABLED = 24


class InjectedIOError(OSError):
    pass


def interrupt(fault):
    if fault == 'kill':
        os.kill(os.getpid(), signal.SIGKILL)
        raise AssertionError('SIGKILL returned')
    raise InjectedIOError('journal operation failed')


class FaultJournal(components._journal.Journal):
    def __init__(self, directory, target, point, fault):
        super().__init__(directory)
        self.target = target
        self.point = point
        self.fault = fault

    def _save(self, state):
        if state['phase'] != self.target:
            return super()._save(state)
        real_fsync, real_replace = os.fsync, os.replace

        def check(point):
            if self.point == point:
                interrupt(self.fault)

        def fsync(fd):
            kind = 'dir-sync' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file-sync'
            check('before-' + kind)
            real_fsync(fd)
            check('after-' + kind)

        def replace(*args, **kwargs):
            check('before-replace')
            real_replace(*args, **kwargs)
            check('after-replace')

        with mock.patch.object(os, 'fsync', fsync), mock.patch.object(os, 'replace', replace):
            return super()._save(state)


class EnabledForTests(components.Orchestrator):
    def _preflight(self):
        pass  # Private test backend only; production remains unavailable.


def phase(directory):
    # Observe publication without fsyncing it on the coordinator's behalf.
    return json.loads((directory / 'state.json').read_bytes())['state']['phase']


def connect(directory):
    db = sqlite3.connect(directory / 'effects.sqlite', timeout=2)
    db.execute('PRAGMA synchronous = FULL')
    return db


class DiskBackend:
    permitted = {
        'capture': ('capture',), 'fence': ('fence', 'rollback'),
        'backup': ('backup',), 'verify_recovery_set': ('backup', 'start_new'),
        'migrate': ('migrate',), 'start_new': ('start_new',), 'open_new': ('committed',),
        'verify_and_restore': ('rollback',), 'restore_old_runtime': ('rollback',),
        # Test-only action invoked by a separate runner, never by the coordinator.
        'simulate_manual_old_write': ('old_ready',),
    }

    def __init__(self, directory, crash_after):
        self.directory = directory
        self.crash_after = crash_after

    def __getattr__(self, name):
        if name not in self.permitted:
            raise AttributeError(name)

        def effect():
            current = phase(self.directory)
            if current not in self.permitted[name]:
                raise AssertionError((name, current))
            with closing(connect(self.directory)) as db, db:
                writer, value, backup, staged = db.execute('SELECT * FROM fixture').fetchone()
                if name == 'fence':
                    if writer == 'new':
                        raise AssertionError('new writer was admitted')
                    writer = 'closed'
                elif name == 'simulate_manual_old_write':
                    if (writer, value, staged) != ('closed', 'baseline', 1):
                        raise AssertionError('old fixture is not ready')
                    writer, value = 'old', 'old post-ready write'
                elif name != 'capture':
                    if writer != 'closed':
                        raise AssertionError((name, writer))
                    if name == 'backup':
                        backup = value
                    elif name == 'verify_recovery_set' and backup != 'baseline':
                        raise AssertionError('bad recovery fixture')
                    elif name == 'migrate':
                        value = 'candidate before admission'
                    elif name == 'open_new':
                        writer, value = 'new', 'new post-commit write'
                    elif name == 'verify_and_restore':
                        if backup != 'baseline':
                            raise AssertionError('missing backup')
                        value = backup
                    elif name == 'restore_old_runtime':
                        if value != 'baseline':
                            raise AssertionError('old data was not restored')
                        staged = 1  # Stage config only; old writes are still fenced.
                db.execute('UPDATE fixture SET writer=?, value=?, backup=?, staged=?',
                           (writer, value, backup, staged))
                db.execute('INSERT INTO effects VALUES (?, ?)', (name, current))
            if name == self.crash_after:
                interrupt('kill')

        return effect


def runner(directory, operation, action, target=None, point=None, fault=None, crash_after=None):
    with FaultJournal(directory, target, point, fault) as journal:
        backend = DiskBackend(directory, crash_after)
        coordinator = EnabledForTests(journal, backend)
        try:
            if action == 'run':
                coordinator.run(operation)
            elif action == 'recover':
                coordinator.recover()
            elif action == 'manual-old-write':
                if journal.load()['phase'] != 'old_ready':
                    raise AssertionError('old writer needs a durable old_ready record')
                backend.simulate_manual_old_write()
            else:
                raise AssertionError(action)
        except InjectedIOError:
            if not journal.failed:
                raise AssertionError('failed journal handle was not poisoned')
            raise SystemExit(SYNC_ERROR) from None
        except components.Unavailable as exc:
            if str(exc) != 'recovery unresolved: automatic gate release is disabled':
                raise
            raise SystemExit(RELEASE_DISABLED) from None


class ControllerDeathTest(unittest.TestCase):
    def setup_fixture(self, tmp):
        directory = Path(tmp)
        with closing(connect(directory)) as db, db:
            db.execute('CREATE TABLE fixture (writer, value, backup, staged)')
            db.execute("INSERT INTO fixture VALUES ('old', 'baseline', NULL, 0)")
            db.execute('CREATE TABLE effects (name, phase)')
        return directory, str(uuid.uuid4())

    def run_controller(self, directory, operation, action, expected, **fault):
        process = multiprocessing.get_context('spawn').Process(
            target=runner, args=(directory, operation, action), kwargs=fault)
        process.start()
        try:
            process.join(10)
            self.assertEqual(process.exitcode, expected, (action, fault))
        finally:
            if process.is_alive():
                process.kill()
                process.join()
            process.close()

    def snapshot(self, directory):
        with closing(connect(directory)) as db:
            return (db.execute('SELECT * FROM fixture').fetchone(),
                    db.execute('SELECT * FROM effects ORDER BY rowid').fetchall())

    def check_old_authoritative(self, directory, operation):
        self.assertEqual(phase(directory), 'old_ready')
        before = self.snapshot(directory)
        self.assertEqual(before[0][:2], ('closed', 'baseline'))
        self.run_controller(directory, operation, 'recover', RELEASE_DISABLED)
        self.assertEqual(self.snapshot(directory), before)
        # Simulate an independent old writer only after the no-restore boundary.
        # This does not implement or authorize gate release.
        self.run_controller(directory, operation, 'manual-old-write', 0)
        written = self.snapshot(directory)
        self.assertEqual(written[0][:2], ('old', 'old post-ready write'))
        self.run_controller(directory, operation, 'recover', RELEASE_DISABLED)
        self.assertEqual(phase(directory), 'old_ready')
        self.assertEqual(self.snapshot(directory), written)

    def test_publication_faults_and_sigkill_at_both_authority_boundaries(self):
        points = {'before-file-sync': False, 'after-file-sync': False,
                  'before-replace': False, 'after-replace': True,
                  'before-dir-sync': True, 'after-dir-sync': True}
        for target in ('committed', 'old_ready'):
            for point, published in points.items():
                for fault, exitcode in (('kill', -signal.SIGKILL), ('io', SYNC_ERROR)):
                    with self.subTest(target=target, point=point, fault=fault), tempfile.TemporaryDirectory() as tmp:
                        directory, operation = self.setup_fixture(tmp)
                        action = 'run'
                        if target == 'old_ready':
                            self.run_controller(directory, operation, 'run', -signal.SIGKILL,
                                                crash_after='migrate')
                            action = 'recover'
                        self.run_controller(directory, operation, action, exitcode,
                                            target=target, point=point, fault=fault)
                        previous = 'start_new' if target == 'committed' else 'rollback'
                        self.assertEqual(phase(directory), target if published else previous)
                        before = self.snapshot(directory)
                        self.assertEqual(before[0][0], 'closed')
                        self.assertNotIn(('open_new', 'committed'), before[1])
                        if target == 'committed' and published:
                            self.run_controller(directory, operation, 'recover', 0)
                            self.assertEqual(phase(directory), 'committed')
                            self.assertEqual(self.snapshot(directory), before)
                        else:
                            self.run_controller(directory, operation, 'recover', RELEASE_DISABLED)
                            after = self.snapshot(directory)
                            expected = [] if published else [
                                ('fence', 'rollback'), ('verify_and_restore', 'rollback'),
                                ('restore_old_runtime', 'rollback')]
                            self.assertEqual(after[1][len(before[1]):], expected)
                            self.assertEqual(phase(directory), 'old_ready')
                            self.assertEqual(after[0], ('closed', 'baseline', 'baseline', 1))

    def test_sigkill_after_new_admission_preserves_postcommit_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, operation = self.setup_fixture(tmp)
            self.run_controller(directory, operation, 'run', -signal.SIGKILL, crash_after='open_new')
            written = self.snapshot(directory)
            self.assertEqual(written[0][:2], ('new', 'new post-commit write'))
            self.assertEqual(written[1][-1], ('open_new', 'committed'))
            for _ in range(2):
                self.run_controller(directory, operation, 'recover', 0)
                self.assertEqual(phase(directory), 'committed')
                self.assertEqual(self.snapshot(directory), written)

    def test_sigkill_after_old_staging_retries_only_before_old_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, operation = self.setup_fixture(tmp)
            self.run_controller(directory, operation, 'run', -signal.SIGKILL, crash_after='migrate')
            self.run_controller(directory, operation, 'recover', -signal.SIGKILL,
                                crash_after='restore_old_runtime')
            self.assertEqual(phase(directory), 'rollback')
            restored = self.snapshot(directory)
            self.assertEqual(restored[0], ('closed', 'baseline', 'baseline', 1))
            self.run_controller(directory, operation, 'recover', RELEASE_DISABLED)
            self.assertEqual(self.snapshot(directory)[1][len(restored[1]):], [
                ('fence', 'rollback'), ('verify_and_restore', 'rollback'), ('restore_old_runtime', 'rollback')])
            self.check_old_authoritative(directory, operation)

    def test_sigkill_before_migration_never_restores_without_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, operation = self.setup_fixture(tmp)
            self.run_controller(directory, operation, 'run', -signal.SIGKILL, crash_after='capture')
            self.run_controller(directory, operation, 'recover', RELEASE_DISABLED)
            self.assertEqual(self.snapshot(directory), (
                ('closed', 'baseline', None, 1),
                [('capture', 'capture'), ('fence', 'rollback'), ('restore_old_runtime', 'rollback')]))
            self.assertEqual(phase(directory), 'old_ready')


if __name__ == '__main__':
    unittest.main()
