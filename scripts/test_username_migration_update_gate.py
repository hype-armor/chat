"""Offline tests with a real, locked migration journal."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import uuid

import username_migration_update_gate as module
import username_migration_systemd_gate as systemd

spec = importlib.util.spec_from_file_location('journal', Path(__file__).with_name('username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'markers').mkdir(mode=0o700)
        (self.root / 'journal').mkdir(mode=0o700)
        self.fd = os.open(self.root / 'markers', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, self.fd)
        self.marker = self.root / 'markers' / module.UpdateGate.MARKER
        self.op = str(uuid.uuid4())
        self.gate = module.UpdateGate(self.fd, self.op)

    def old_ready(self, j):
        j.begin(self.op)
        j.begin_rollback()
        j.advance('old_ready')

    def test_release_blocked_and_verify_fsync_error_propagates(self):
        self.gate.engage()
        self.assertTrue(self.gate.verify())
        with mock.patch.object(module.os, 'fsync', side_effect=OSError('injected')):
            with self.assertRaisesRegex(OSError, 'injected'):
                self.gate.verify()
        self.assertEqual(self.marker.read_text(), self.op + '\n')
        self.assertTrue(self.gate.verify())
        with journal_module.Journal(self.root / 'journal') as j:
            self.old_ready(j)
            for _ in range(2):
                with self.assertRaisesRegex(module.UpdateGateError, 'automatic release disabled'):
                    self.gate.clear_old_ready(j)
                self.assertEqual(self.marker.read_text(), self.op + '\n')

    def test_publish_crash_and_resume(self):
        with mock.patch.object(module.os, 'fsync', side_effect=lambda fd: (_ for _ in ()).throw(OSError()) if fd == self.fd else None):
            with self.assertRaises(OSError):
                self.gate.engage()
        self.assertEqual(self.marker.read_text(), self.op + '\n')
        self.gate.engage(resume=True)
        with self.assertRaises(FileExistsError):
            self.gate.engage()

    def test_stale_journal_and_post_cutover(self):
        self.gate.engage()
        with journal_module.Journal(self.root / 'journal') as j:
            j.begin(str(uuid.uuid4()))
            j.begin_rollback()
            j.advance('old_ready')
            with self.assertRaises(module.UpdateGateError):
                self.gate.clear_old_ready(j)
            self.assertEqual(self.marker.read_text(), self.op + '\n')
        (self.root / 'other').mkdir(mode=0o700)
        with journal_module.Journal(self.root / 'other') as j:
            j.begin(self.op)
            for phase in ('fence', 'backup', 'migrate', 'start_new', 'committed'):
                j.advance(phase)
            for phase in ('committed', 'complete'):
                with self.assertRaises(module.UpdateGateError):
                    self.gate.clear_old_ready(j)
                self.assertTrue(self.marker.exists())
                if phase == 'committed':
                    j.advance('complete')
        with self.assertRaisesRegex(module.UpdateGateError, 'automatic release disabled'):
            self.gate.clear_old_ready(j)
        self.assertEqual(self.marker.read_text(), self.op + '\n')

    def test_bad_marker_and_symlinks(self):
        target = self.root / 'target'
        target.write_text(self.op + '\n')
        self.marker.symlink_to(target)
        with self.assertRaises(OSError):
            self.gate.engage(resume=True)
        self.marker.unlink()
        self.marker.write_text('unexpected')
        os.chmod(self.marker, 0o600)
        with self.assertRaises(module.UpdateGateError):
            self.gate.engage(resume=True)
        with journal_module.Journal(self.root / 'journal') as j:
            self.old_ready(j)
            with self.assertRaises(module.UpdateGateError):
                self.gate.clear_old_ready(j)
        self.assertEqual(self.marker.read_text(), 'unexpected')

    def test_both_releases_blocked(self):
        (self.root / 'unit').mkdir(mode=0o700)
        marker = self.root / 'unit' / 'marker'
        dropin = self.root / 'unit' / 'dropin'
        dropin.write_text('[Unit]\nConditionPathExists=!' + str(marker) + '\n')
        def runner(args):
            if args == ['daemon-reload']:
                return ''
            return ('LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n'
                    f'DropInPaths={dropin}\nConditions={{ type=ConditionPathExists ; '
                    f'trigger=no ; negate=yes ; path={marker} ; state=failed }}\n')
        gate = systemd.SystemdGate(self.op, runner=runner, marker=str(marker),
                                   dropin=str(dropin), trusted_root=str(self.root))
        with journal_module.Journal(self.root / 'journal') as j:
            j.begin(self.op)
            self.gate.engage()
            gate.engage()
            j.begin_rollback()
            j.advance('old_ready')
            with self.assertRaisesRegex(module.UpdateGateError, 'automatic release disabled'):
                self.gate.clear_old_ready(j)
            with self.assertRaisesRegex(systemd.GateError, 'Automatic release disabled'):
                gate.clear_old_ready(j)
            self.assertEqual(self.marker.read_text(), self.op + '\n')
            self.assertEqual(marker.read_text(), self.op + '\n')
            self.assertTrue(dropin.exists())

    def test_two_operations_and_private_directory(self):
        with journal_module.Journal(self.root / 'journal') as j:
            self.old_ready(j)
            self.gate.engage()
            with self.assertRaises(module.UpdateGateError):
                self.gate.clear_old_ready(j)
        other = str(uuid.uuid4())
        second = module.UpdateGate(self.fd, other)
        with self.assertRaises(FileExistsError):
            second.engage()
        with self.assertRaises(module.UpdateGateError):
            second.engage(resume=True)
        self.assertEqual(self.marker.read_text(), self.op + '\n')
        os.chmod(self.root / 'markers', 0o755)
        with self.assertRaises(module.UpdateGateError):
            module.UpdateGate(self.fd, other)


if __name__ == '__main__':
    unittest.main()
