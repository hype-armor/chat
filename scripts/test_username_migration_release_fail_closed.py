"""Offline checks for the disabled, incomplete release protocol."""
import importlib.util
import os
import pathlib
import tempfile
import unittest
import uuid
from unittest import mock

from username_migration_systemd_gate import GateError, SystemdGate
from username_migration_update_gate import UpdateGate, UpdateGateError

spec = importlib.util.spec_from_file_location(
    'migration_journal', pathlib.Path(__file__).with_name('username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class ReleaseFailsClosed(unittest.TestCase):
    def test_gate_release_never_unlinks_or_accepts_absence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            update_dir = root / 'update'
            update_dir.mkdir(mode=0o700)
            fd = os.open(update_dir, os.O_RDONLY | os.O_DIRECTORY)
            self.addCleanup(os.close, fd)
            operation = str(uuid.uuid4())
            update = UpdateGate(fd, operation)
            marker = root / 'systemd-marker'
            dropin = root / 'gate.conf'
            systemd = SystemdGate(operation, runner=lambda args: '', marker=str(marker),
                                  dropin=str(dropin), trusted_root=str(root))
            update_marker = update_dir / UpdateGate.MARKER
            update_marker.write_bytes(update.data)
            update_marker.chmod(0o600)
            marker.write_bytes(systemd.marker_data)
            marker.chmod(0o600)
            for gate, error, message, path in (
                    (update, UpdateGateError, 'automatic release disabled', update_marker),
                    (systemd, GateError, 'Automatic release disabled', marker)):
                for phase in ('old_ready', 'rolled_back', 'old_releasing'):
                    with self.subTest(gate=type(gate).__name__, phase=phase):
                        journal = mock.Mock()
                        journal.load.return_value = {'phase': phase}
                        before = (path.read_bytes(), path.stat().st_dev, path.stat().st_ino)
                        with mock.patch('os.unlink') as unlink, self.assertRaisesRegex(error, message):
                            gate.clear_old_ready(journal)
                        unlink.assert_not_called()
                        self.assertEqual(before, (path.read_bytes(), path.stat().st_dev, path.stat().st_ino))
                path.unlink()
                with self.subTest(gate=type(gate).__name__, marker='absent'):
                    with self.assertRaisesRegex(error, message):
                        gate.clear_old_ready(mock.Mock())
                    self.assertFalse(path.exists())

    def test_old_ready_never_returns_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            with journal_module.Journal(directory) as journal:
                journal.begin(str(uuid.uuid4()))
                for phase in ('fence', 'backup', 'migrate'):
                    journal.advance(phase)
                journal.begin_rollback()
                self.assertEqual(journal.recovery_decision(), 'restore_old')
                journal.advance('old_ready')
                self.assertEqual(journal.recovery_decision(), 'resume_old')
                with self.assertRaises(journal_module.JournalError):
                    journal.advance('old_releasing')
                self.assertEqual(journal.recovery_decision(), 'resume_old')


if __name__ == '__main__':
    unittest.main()
