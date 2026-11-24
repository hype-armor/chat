import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import uuid

PATH = Path(__file__).with_name('username-migration-journal.py')
spec = importlib.util.spec_from_file_location('journal', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.op = str(uuid.uuid4())

    def begin(self, j, until='capture'):
        j.begin(self.op)
        for phase in ('fence', 'backup', 'migrate', 'start_new', 'committed', 'complete'):
            if j.load()['phase'] == until:
                break
            j.advance(phase)

    def test_forward_and_cutover_is_irreversible(self):
        with m.Journal(self.path) as j:
            self.begin(j, 'committed')
            self.assertEqual(j.recovery_decision(), 'leave_new')
            with self.assertRaises(m.JournalError):
                j.begin_rollback()
            with self.assertRaises(m.JournalError):
                j.advance('start_new')
            j.advance('complete')
            self.assertEqual(j.recovery_decision(), 'leave_new')
        with m.Journal(self.path) as j:
            self.assertEqual(j.recovery_decision(), 'leave_new')
            with self.assertRaises(m.JournalError):
                j.begin(self.op)

    def test_recovery_at_every_boundary(self):
        for phase in ('capture', 'fence', 'backup', 'migrate', 'start_new'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as path:
                with m.Journal(path) as j:
                    self.begin(j, phase)
                with m.Journal(path) as j:
                    self.assertEqual(j.recovery_decision(), 'begin_rollback')
                    j.begin_rollback()
                with m.Journal(path) as j:
                    self.assertEqual(j.recovery_decision(), 'restore_old' if phase in ('migrate', 'start_new') else 'recover_old_runtime')
                    j.advance('old_ready')
                with m.Journal(path) as j:
                    self.assertEqual(j.recovery_decision(), 'resume_old')
                    with self.assertRaises(m.JournalError):
                        j.begin_rollback()
                    with self.assertRaises(m.JournalError):
                        j.advance('rolled_back')
                    self.assertEqual(j.load()['phase'], 'old_ready')
                    self.assertEqual(j.recovery_decision(), 'resume_old')
                with m.Journal(path) as j:
                    self.assertEqual(j.load()['phase'], 'old_ready')
                    self.assertEqual(j.recovery_decision(), 'resume_old')

    def test_legacy_rolled_back_never_selects_restore(self):
        for restore in (False, True):
            with self.subTest(restore=restore), tempfile.TemporaryDirectory() as path:
                with m.Journal(path) as j:
                    self.begin(j, 'migrate' if restore else 'capture')
                    j.begin_rollback()
                    j.advance('old_ready')
                file = Path(path) / 'state.json'
                state = json.loads(file.read_text())['state']
                state['phase'] = 'rolled_back'
                file.write_bytes(m._canonical({'state': state, 'sha256': m.hashlib.sha256(m._canonical(state)).hexdigest()}))
                with m.Journal(path) as j:
                    self.assertEqual(j.load()['restore_required'], restore)
                    self.assertEqual(j.recovery_decision(), 'resume_old')
                    with self.assertRaises(m.JournalError):
                        j.begin_rollback()
                    with self.assertRaises(m.JournalError):
                        j.advance('old_ready')

    def test_bad_state_and_permissions_fail_closed(self):
        with m.Journal(self.path) as j:
            self.begin(j)
        file = self.path / 'state.json'
        original = file.read_bytes()
        for data in (b'{', b'{}', b'{"state":{},"state":{},"sha256":"x"}', original.replace(b'capture', b'migrate'), b'x' * 4097):
            file.write_bytes(data)
            with m.Journal(self.path) as j, self.assertRaises(m.JournalError):
                j.recovery_decision()
        file.write_bytes(original)
        file.chmod(0o644)
        with m.Journal(self.path) as j, self.assertRaises(m.JournalError):
            j.load()
        file.unlink()
        file.symlink_to('/dev/null')
        with m.Journal(self.path) as j, self.assertRaises(OSError):
            j.load()

    def test_schema_validation_even_with_valid_checksum(self):
        with m.Journal(self.path) as j:
            self.begin(j)
        file = self.path / 'state.json'
        state = json.loads(file.read_text())['state']
        for key, value in [('phase', 'unknown'), ('version', True), ('restore_required', False), ('operation_id', 'bad')]:
            changed = dict(state, **{key: value})
            file.write_bytes(m._canonical({'state': changed, 'sha256': m.hashlib.sha256(m._canonical(changed)).hexdigest()}))
            with m.Journal(self.path) as j, self.assertRaises(m.JournalError):
                j.load()

    def test_failed_fsync_poison_and_reopen(self):
        # advance first syncs the existing state and directory, then saves.
        for failure in (3, 4):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as path:
                with m.Journal(path) as j:
                    self.begin(j, 'start_new')
                    real = os.fsync
                    calls = []
                    def fsync(fd):
                        calls.append(fd)
                        if len(calls) == failure:
                            raise OSError('injected fsync failure')
                        return real(fd)
                    with mock.patch.object(m.os, 'fsync', side_effect=fsync), self.assertRaises(OSError):
                        j.advance('committed')
                    with self.assertRaises(m.JournalError):
                        j.recovery_decision()
                with m.Journal(path) as j:
                    self.assertEqual(j.recovery_decision(), 'begin_rollback' if failure == 3 else 'leave_new')

    def test_reopened_state_must_sync_before_recovery(self):
        for failure in (1, 2):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as path:
                with m.Journal(path) as j:
                    self.begin(j, 'committed')
                with m.Journal(path) as j:
                    real = os.fsync
                    calls = []
                    def fsync(fd):
                        calls.append(fd)
                        if len(calls) == failure:
                            raise OSError('injected recovery fsync failure')
                        return real(fd)
                    with mock.patch.object(m.os, 'fsync', side_effect=fsync), self.assertRaises(OSError):
                        j.recovery_decision()
                    with self.assertRaises(m.JournalError):
                        j.recovery_decision()
                with m.Journal(path) as j:
                    self.assertEqual(j.recovery_decision(), 'leave_new')

    def test_process_exit_after_durable_cutover_and_lock_exclusion(self):
        code = '''import importlib.util, os, sys
s=importlib.util.spec_from_file_location('j', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
with m.Journal(sys.argv[2]) as j:
 j.advance('committed')
 os._exit(19)
'''
        with m.Journal(self.path) as j:
            self.begin(j, 'start_new')
            result = subprocess.run([sys.executable, '-c', code, str(PATH), str(self.path)], capture_output=True)
            self.assertNotEqual(result.returncode, 19)
        result = subprocess.run([sys.executable, '-c', code, str(PATH), str(self.path)], capture_output=True)
        self.assertEqual(result.returncode, 19, result.stderr)
        with m.Journal(self.path) as j:
            self.assertEqual(j.recovery_decision(), 'leave_new')

    def test_insecure_directory_and_invalid_transitions(self):
        os.chmod(self.path, 0o755)
        with self.assertRaises(m.JournalError):
            with m.Journal(self.path):
                pass
        os.chmod(self.path, 0o700)
        with m.Journal(self.path) as j:
            self.assertEqual(j.recovery_decision(), 'no_operation')
            self.begin(j)
            with self.assertRaises(m.JournalError):
                j.advance('committed')
            with self.assertRaises(m.JournalError):
                j.begin(str(uuid.uuid4()))


if __name__ == '__main__':
    unittest.main()
