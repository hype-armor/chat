"""Offline integration checks for the durable journal and persistent gate."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import uuid

import username_migration_systemd_gate as gate_module

spec = importlib.util.spec_from_file_location(
    'migration_journal', Path(__file__).with_name('username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ('state', 'unit.d', 'journal1', 'journal2'):
            (self.root / name).mkdir(mode=0o700)
        self.marker = self.root / 'state' / 'marker'
        self.dropin = self.root / 'unit.d' / 'maintenance.conf'
        self.dropin.write_text('[Unit]\nConditionPathExists=!' + str(self.marker) + '\n')
        self.op1, self.op2 = str(uuid.uuid4()), str(uuid.uuid4())
        self.manager = mock.Mock(side_effect=self.manager_response)
        self.backend = mock.Mock()

    def manager_response(self, args):
        if args == ['daemon-reload']:
            return ''
        return ('LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n'
                f'DropInPaths={self.dropin}\n'
                'Conditions={ type=ConditionPathExists ; trigger=no ; negate=yes ; '
                f'path={self.marker} ; state=failed }}\n')

    def gate(self, op):
        return gate_module.SystemdGate(op, runner=self.manager, marker=str(self.marker),
                                       dropin=str(self.dropin), trusted_root=str(self.root))

    def old_ready(self, journal, op):
        journal.begin(op)
        for phase in ('fence', 'backup', 'migrate'):
            journal.advance(phase)
        journal.begin_rollback()
        self.assertEqual(journal.recovery_decision(), 'restore_old')
        self.backend.restore()
        journal.advance('old_ready')

    def recover(self, journal, gate):
        decision = journal.recovery_decision()
        if decision == 'restore_old':
            self.backend.restore()
            journal.advance('old_ready')
        if journal.recovery_decision() == 'resume_old':
            gate.clear_old_ready(journal)

    def test_old_ready_release_stays_blocked_after_reopen_without_restore(self):
        gate = self.gate(self.op1)
        with journal_module.Journal(self.root / 'journal1') as journal:
            journal.begin(self.op1)
            gate.engage()
            for phase in ('fence', 'backup', 'migrate'):
                journal.advance(phase)
            journal.begin_rollback()
            self.backend.restore()
            journal.advance('old_ready')
            self.backend.reset_mock()
        with journal_module.Journal(self.root / 'journal1') as journal:
            self.assertEqual(journal.load()['phase'], 'old_ready')
            with self.assertRaisesRegex(gate_module.GateError, 'Automatic release disabled'):
                self.recover(journal, gate)
            self.assertEqual(self.marker.read_text(), self.op1 + '\n')
            self.assertEqual(journal.load()['phase'], 'old_ready')
        with journal_module.Journal(self.root / 'journal1') as journal:
            self.assertEqual(journal.recovery_decision(), 'resume_old')
            with self.assertRaisesRegex(gate_module.GateError, 'Automatic release disabled'):
                self.recover(journal, self.gate(self.op1))
            self.assertEqual(journal.load()['phase'], 'old_ready')
            self.assertEqual(self.marker.read_text(), self.op1 + '\n')
        self.backend.restore.assert_not_called()
        self.assertTrue(self.dropin.exists())

    def test_committed_cannot_release_and_other_operation_cannot_release_marker(self):
        gate = self.gate(self.op1)
        with journal_module.Journal(self.root / 'journal1') as journal:
            journal.begin(self.op1)
            gate.engage()
            for phase in ('fence', 'backup', 'migrate', 'start_new', 'committed'):
                journal.advance(phase)
            self.assertEqual(journal.recovery_decision(), 'leave_new')
            with self.assertRaises(gate_module.GateError):
                gate.clear_old_ready(journal)
            with self.assertRaises(journal_module.JournalError):
                journal.begin_rollback()
        with journal_module.Journal(self.root / 'journal2') as journal:
            self.old_ready(journal, self.op2)
            with self.assertRaises(gate_module.GateError):
                self.gate(self.op2).clear_old_ready(journal)
            with self.assertRaises(gate_module.GateError):
                gate.clear_old_ready(journal)
        self.assertEqual(self.marker.read_text(), self.op1 + '\n')

    def test_blocked_release_prevents_next_operation(self):
        original = self.dropin.stat().st_ino, self.dropin.read_bytes()
        with journal_module.Journal(self.root / 'journal1') as journal:
            gate = self.gate(self.op1)
            gate.engage()
            self.old_ready(journal, self.op1)
            self.backend.reset_mock()
            with self.assertRaisesRegex(gate_module.GateError, 'Automatic release disabled'):
                self.recover(journal, gate)
            self.assertEqual(journal.load()['phase'], 'old_ready')
        with journal_module.Journal(self.root / 'journal2') as journal:
            journal.begin(self.op2)
            with self.assertRaises(gate_module.GateError):
                self.gate(self.op2).engage()
        self.backend.restore.assert_not_called()
        self.assertEqual(self.marker.read_text(), self.op1 + '\n')
        self.assertEqual((self.dropin.stat().st_ino, self.dropin.read_bytes()), original)
        self.assertTrue(all(call.args[0] == ['daemon-reload'] or call.args[0][0] == 'show'
                            for call in self.manager.call_args_list))

    def test_preinstalled_dropin_verification_faults_prevent_marker_publication(self):
        original = self.dropin.read_bytes()
        cases = ('missing', 'tampered', 'fsync', 'manager')
        for case in cases:
            with self.subTest(case=case):
                if case == 'missing':
                    self.dropin.unlink()
                elif case == 'tampered':
                    self.dropin.write_bytes(b'invalid condition\n')
                real_fsync = os.fsync
                def fsync(fd):
                    if case == 'fsync' and os.fstat(fd).st_ino == self.dropin.stat().st_ino:
                        raise OSError('injected drop-in fsync failure')
                    return real_fsync(fd)
                if case == 'manager':
                    self.manager.side_effect = lambda args: 'LoadState=loaded\n'
                try:
                    with mock.patch.object(gate_module.os, 'fsync', side_effect=fsync):
                        with self.assertRaises(gate_module.GateError):
                            self.gate(self.op1).engage()
                    self.assertFalse(self.marker.exists())
                finally:
                    self.dropin.write_bytes(original)
                    self.manager.side_effect = self.manager_response

    def test_install_and_reuse_publication_faults(self):
        # A failed publication can leave the marker visible or absent.
        # Missing after an uncertain publication cannot authorize a retry.
        for boundary in ('before_rename', 'after_rename', 'file_fsync', 'dir_fsync'):
            for target in ('marker',):
                with self.subTest(boundary=boundary, target=target):
                    with tempfile.TemporaryDirectory() as root:
                        root = Path(root)
                        for name in ('state', 'unit.d', 'journal'):
                            (root / name).mkdir(mode=0o700)
                        marker, dropin = root / 'state' / 'marker', root / 'unit.d' / 'gate.conf'
                        dropin.write_text('[Unit]\nConditionPathExists=!' + str(marker) + '\n')
                        def manager(args):
                            if args == ['daemon-reload']:
                                return ''
                            return ('LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n'
                                    f'DropInPaths={dropin}\nConditions={{ type=ConditionPathExists ; '
                                    f'trigger=no ; negate=yes ; path={marker} ; state=failed }}\n')
                        op = str(uuid.uuid4())
                        def gate(operation):
                            return gate_module.SystemdGate(operation, runner=manager, marker=str(marker),
                                                           dropin=str(dropin), trusted_root=str(root))
                        journal_path = root / 'journal'
                        real_rename, real_fsync = gate_module._rename_noreplace, os.fsync
                        destination = marker if target == 'marker' else dropin
                        fired = []
                        def rename(parent, source, name):
                            hit = name == destination.name
                            if hit and boundary == 'before_rename':
                                fired.append(True)
                                raise OSError('before rename')
                            result = real_rename(parent, source, name)
                            if hit and boundary == 'after_rename':
                                fired.append(True)
                                raise OSError('after rename')
                            return result
                        def fsync(fd):
                            info = os.fstat(fd)
                            parent = destination.parent.stat()
                            # File fsync is on a temporary file in the selected parent.
                            fd_path = os.readlink(f'/proc/self/fd/{fd}')
                            file_hit = fd_path.startswith(str(destination.parent / '.gate-'))
                            dir_hit = (info.st_dev, info.st_ino) == (parent.st_dev, parent.st_ino)
                            if not fired and ((boundary == 'file_fsync' and file_hit) or
                                              (boundary == 'dir_fsync' and dir_hit)):
                                fired.append(True)
                                raise OSError('injected fsync')
                            return real_fsync(fd)
                        with journal_module.Journal(journal_path) as j:
                            j.begin(op)
                            with mock.patch.object(gate_module, '_rename_noreplace', side_effect=rename), \
                                 mock.patch.object(gate_module.os, 'fsync', side_effect=fsync):
                                with self.assertRaises(gate_module.GateError):
                                    gate(op).engage()
                            self.assertTrue(fired)
                        with journal_module.Journal(journal_path) as j:
                            self.assertEqual(j.load()['operation_id'], op)
                            if marker.exists():
                                gate(op).engage(resume=True)
                                self.assertEqual(marker.read_text(), op + '\n')
                                j.begin_rollback()
                                j.advance('old_ready')
                                with self.assertRaisesRegex(gate_module.GateError, 'Automatic release disabled'):
                                    gate(op).clear_old_ready(j)
                                self.assertEqual(j.load()['phase'], 'old_ready')
                                self.assertEqual(marker.read_text(), op + '\n')
                            else:
                                with self.assertRaises(gate_module.GateError):
                                    gate(op).engage(resume=True)
                                self.assertFalse(marker.exists())
                        if fired and boundary in ('after_rename', 'dir_fsync'):
                            self.assertEqual(marker.read_text(), op + '\n')
                        else:
                            self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
