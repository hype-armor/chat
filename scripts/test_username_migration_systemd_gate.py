import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import username_migration_systemd_gate as gate_module
from username_migration_systemd_gate import GateError, SystemdGate


class Journal:
    def __init__(self, phase='old_ready', op='op1'):
        self.state = {'phase': phase, 'operation_id': op}

    def load(self):
        return self.state


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'state').mkdir()
        (self.root / 'unit.d').mkdir()
        self.marker = str(self.root / 'state' / 'marker')
        self.dropin = str(self.root / 'unit.d' / '90-chat-maintenance.conf')
        self.calls = []
        self.runtime = False
        self.loaded = True
        self.gate = self.new_gate()
        Path(self.dropin).write_bytes(self.gate.dropin_data)

    def new_gate(self, op='op1'):
        return SystemdGate(op, runner=self.run_systemctl, marker=self.marker,
                           dropin=self.dropin, trusted_root=str(self.root))

    def run_systemctl(self, args):
        self.calls.append(args)
        return ('LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n'
                f'DropInPaths={self.dropin if self.loaded else ""}'
                f'{" /run/systemd/system/foo.conf" if self.runtime else ""}\n'
                'Conditions={ type=ConditionPathExists ; trigger=no ; negate=yes ; '
                f'path={self.marker} ; state=failed }}\n')

    def test_engage_and_block_all_automatic_release(self):
        self.gate.engage()
        self.assertTrue(self.gate.verify())
        for journal in (Journal(), Journal('committed'), Journal('rollback'), Journal(op='other')):
            with self.subTest(state=journal.state):
                with self.assertRaisesRegex(GateError, 'Automatic release disabled'):
                    self.gate.clear_old_ready(journal)
                self.assertEqual(Path(self.marker).read_bytes(), self.gate.marker_data)
                self.assertEqual(Path(self.dropin).read_bytes(), self.gate.dropin_data)
        with self.assertRaisesRegex(GateError, 'already exists'):
            self.new_gate('op2').engage()
        self.assertTrue(all(call[0] == 'show' for call in self.calls))

    def test_missing_wrong_or_unloaded_dropin_never_publishes(self):
        for mode in ('missing', 'wrong', 'unloaded', 'runtime'):
            with self.subTest(mode=mode):
                Path(self.dropin).write_bytes(self.gate.dropin_data)
                self.loaded = True
                self.runtime = False
                if mode == 'missing':
                    Path(self.dropin).unlink()
                elif mode == 'wrong':
                    Path(self.dropin).write_text('admin\n')
                elif mode == 'unloaded':
                    self.loaded = False
                else:
                    self.runtime = True
                with self.assertRaises(GateError):
                    self.gate.engage()
                self.assertFalse(Path(self.marker).exists())
                if mode == 'missing':
                    self.assertFalse(Path(self.dropin).exists())

    def test_failed_publication_and_resume(self):
        real = gate_module._rename_noreplace
        def rename_then_fail(parent, source, destination):
            real(parent, source, destination)
            raise OSError('lost publication reply')
        with mock.patch.object(gate_module, '_rename_noreplace', side_effect=rename_then_fail):
            with self.assertRaises(GateError):
                self.gate.engage()
        self.assertEqual(Path(self.marker).read_text(), 'op1\n')
        with self.assertRaisesRegex(GateError, 'already exists'):
            self.new_gate().engage_initial()
        self.new_gate().engage(resume=True)
        with self.assertRaises(GateError):
            self.new_gate('op2').engage(resume=True)

    def test_initial_engagement_does_not_infer_recovery(self):
        Path(self.marker).write_bytes(self.gate.marker_data)
        with self.assertRaisesRegex(GateError, 'already exists'):
            self.gate.engage_initial()
        self.assertEqual(Path(self.marker).read_bytes(), self.gate.marker_data)
        self.gate.engage(resume=True)  # Separate, explicit recovery decision.

    def test_marker_condition_must_not_be_an_or_trigger(self):
        original = self.gate.runner
        for trigger, error in (('yes', 'not mandatory'), ('unknown', 'Invalid condition fields'),
                               ('', 'Invalid condition fields'), ('no ; trigger=yes', 'Invalid condition fields')):
            with self.subTest(trigger=trigger):
                def injected(args):
                    response = original(args).replace('trigger=no', 'trigger=' + trigger)
                    # Both conditions belong to the same Conditions property.
                    return response.rstrip('\n') + (
                        ' { type=ConditionPathExists ; trigger=yes ; negate=no ; '
                        'path=/other ; state=succeeded }\n')
                self.gate.runner = injected
                with self.assertRaisesRegex(GateError, error):
                    self.gate.engage_initial()
                self.assertFalse(Path(self.marker).exists())

    def test_invalid_condition_entries_rejected_before_publication(self):
        original = self.gate.runner
        cases = ('state=failed ; extra=x', 'state=', 'state=unknown',
                 'state=failed ; state=failed', 'state', 'state=failed ;',
                 'negate=maybe', 'type=', 'path=relative', 'path=/a/../b')
        for replacement in cases:
            with self.subTest(replacement=replacement):
                target = ('negate=yes' if replacement.startswith('negate=') else
                          'type=ConditionPathExists' if replacement.startswith('type=') else
                          'path=' + self.marker if replacement.startswith('path=') else 'state=failed')
                self.gate.runner = lambda args: original(args).replace(target, replacement)
                with self.assertRaisesRegex(GateError, 'Invalid condition fields'):
                    self.gate.engage_initial()
                self.assertFalse(Path(self.marker).exists())

    def test_manager_rejects_non_normalized_paths_before_publication(self):
        original = self.gate.runner
        fragments = ('/etc/systemd/system/../../run/pi-chat.service',
                     '/etc/systemd/system/./pi-chat.service',
                     '/etc/systemd/system//pi-chat.service')
        dropins = ('/etc/../run/systemd/system/foo.conf',
                   '/run/systemd/system/foo.conf', '/run',
                   '/etc/systemd/./foo.conf', 'relative.conf', '//etc/systemd/foo.conf')
        for kind, paths in (('fragment', fragments), ('dropin', dropins)):
            for path in paths:
                with self.subTest(kind=kind, path=path):
                    def injected(args):
                        response = original(args)
                        if kind == 'fragment':
                            return response.replace('/etc/systemd/system/pi-chat.service', path)
                        return response.replace('DropInPaths=' + self.dropin,
                                                'DropInPaths=' + self.dropin + ' ' + path)
                    self.gate.runner = injected
                    with self.assertRaises(GateError):
                        self.gate.engage_initial()
                    self.assertFalse(Path(self.marker).exists())

    def test_condition_entries_require_whitespace(self):
        original = self.gate.runner
        other = '{ type=ConditionPathExists ; trigger=no ; negate=no ; path=/other ; state=failed }'
        for separator, valid in ((' ', True), ('\t', True), ('', False)):
            with self.subTest(separator=separator):
                self.gate.runner = lambda args: original(args).replace(
                    'Conditions=', 'Conditions=' + other + separator)
                if valid:
                    self.gate._verify_manager()
                else:
                    with self.assertRaisesRegex(GateError, 'Invalid conditions response'):
                        self.gate._verify_manager()

    def test_trusted_root_slash_and_unsafe_paths(self):
        gate = SystemdGate('op1', runner=self.run_systemctl, marker=self.marker,
                           dropin=self.dropin, trusted_root='/')
        self.assertEqual(gate.root, '/')
        for path in ('/', '/bad path', '/tmp/../bad', '//bad'):
            with self.subTest(path=path), self.assertRaisesRegex(GateError, 'Unsafe path'):
                SystemdGate('op1', runner=self.run_systemctl, marker=path,
                            dropin=self.dropin, trusted_root='/')

    def test_absent_marker_on_resume_is_not_a_new_publication(self):
        with mock.patch.object(gate_module, '_rename_noreplace', side_effect=OSError('failure')):
            with self.assertRaises(GateError):
                self.gate.engage()
        with self.assertRaises(GateError):
            self.new_gate().engage(resume=True)
        self.assertFalse(Path(self.marker).exists())

    def test_release_never_unlinks_or_reconciles(self):
        self.gate.engage()
        with mock.patch.object(gate_module.os, 'unlink', side_effect=AssertionError('unlink called')):
            for _ in range(2):
                with self.assertRaisesRegex(GateError, 'Automatic release disabled'):
                    self.gate.clear_old_ready(Journal())
                self.assertEqual(Path(self.marker).read_bytes(), self.gate.marker_data)
        Path(self.marker).unlink()
        with self.assertRaisesRegex(GateError, 'Automatic release disabled'):
            self.gate.clear_old_ready(Journal())
        self.assertFalse(Path(self.marker).exists())

    def test_verification_errors_propagate_and_keep_marker(self):
        self.gate.engage()
        for error, message in ((GateError('manager rejected'), 'manager rejected'),
                               (OSError('manager failed'), 'Gate verification failed')):
            with self.subTest(error=error), mock.patch.object(self.gate, 'runner', side_effect=error):
                with self.assertRaisesRegex(GateError, message):
                    self.gate.verify()
                self.assertEqual(Path(self.marker).read_bytes(), self.gate.marker_data)

    def test_dropin_replacement_after_publication_is_rejected(self):
        original = self.gate._create
        def replace_dropin(path, data):
            identity = original(path, data)
            replacement = Path(self.dropin + '.new')
            replacement.write_bytes(self.gate.dropin_data)
            os.replace(replacement, self.dropin)
            return identity
        with mock.patch.object(self.gate, '_create', side_effect=replace_dropin):
            with self.assertRaises(GateError):
                self.gate.engage()
        self.assertTrue(Path(self.marker).exists())

    def test_manager_change_after_publication_is_rejected(self):
        original = self.gate._create
        def change_manager(path, data):
            identity = original(path, data)
            self.loaded = False
            return identity
        with mock.patch.object(self.gate, '_create', side_effect=change_manager):
            with self.assertRaises(GateError):
                self.gate.engage()
        self.assertTrue(Path(self.marker).exists())

    def test_symlink_and_unsafe_directory_rejected(self):
        os.symlink(self.root / 'target', self.marker)
        with self.assertRaises(GateError):
            self.gate.engage(resume=True)
        os.unlink(self.marker)
        os.chmod(self.root / 'state', 0o777)
        with self.assertRaises(GateError):
            self.gate.engage()
        with self.assertRaises(GateError):
            SystemdGate('op1', runner=self.run_systemctl, marker=str(self.root / 'bad path'),
                        dropin=self.dropin, trusted_root=str(self.root))


if __name__ == '__main__':
    unittest.main()
