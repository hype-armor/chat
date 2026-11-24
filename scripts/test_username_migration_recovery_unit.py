import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import username_migration_recovery_unit as unit


class RecoveryUnitTest(unittest.TestCase):
    def test_fixed_unit_and_ordering(self):
        with mock.patch.object(unit, '_check_trusted_executable') as check:
            result = unit.generate_unit()
        check.assert_called_once_with(unit.EXECUTABLE)
        for line in ('Requires=docker.service', 'After=docker.service',
                     'Before=pi-chat.service', 'RequiredBy=pi-chat.service',
                     'WantedBy=multi-user.target', 'Restart=on-failure',
                     'KillMode=control-group', 'Type=oneshot',
                     'ExecStart=' + unit.EXECUTABLE):
            self.assertIn(line + '\n', result)
        self.assertEqual(result.count('ExecStart='), 1)
        self.assertNotIn('Environment=', result)
        self.assertNotIn('/bin/sh', result)

    def test_unknown_or_missing_dependencies_fail_before_path_check(self):
        for dependencies in ((), ('docker.service', 'network.target'),
                             ('podman.service',), ['docker.service']):
            with self.subTest(dependencies=dependencies):
                with mock.patch.object(unit, '_check_trusted_executable') as check:
                    with self.assertRaises(unit.UnitError):
                        unit.generate_unit(dependencies=dependencies)
                    check.assert_not_called()

    def test_trust_failure_prevents_generation(self):
        with mock.patch.object(unit, '_check_trusted_executable', side_effect=unit.UnitError('bad')):
            with self.assertRaises(unit.UnitError):
                unit.generate_unit()

    def test_rejects_bad_paths_before_filesystem_access(self):
        for path in ('relative', '/a/../b', '/a//b', '/a;id', '/a $x',
                     '/a%foo', '/a\nExecStart=/bin/sh', '/'):
            with self.subTest(path=path), mock.patch.object(unit.os, 'lstat') as lookup:
                with self.assertRaises(unit.UnitError):
                    unit._check_trusted_executable(path)
                lookup.assert_not_called()

    def test_rejects_untrusted_components(self):
        directory = mock.Mock(st_uid=0, st_mode=0o040755)
        executable = mock.Mock(st_uid=0, st_mode=0o100755)
        bad_values = (mock.Mock(st_uid=1000, st_mode=0o040755),
                      mock.Mock(st_uid=0, st_mode=0o040777),
                      mock.Mock(st_uid=0, st_mode=0o120777))
        for bad in bad_values:
            with self.subTest(mode=bad.st_mode), mock.patch.object(unit.os, 'lstat', side_effect=[directory, bad]):
                with self.assertRaises(unit.UnitError):
                    unit._check_trusted_executable('/a/exec')
        with mock.patch.object(unit.os, 'lstat', side_effect=[directory, directory, executable]):
            unit._check_trusted_executable('/a/exec')
        with mock.patch.object(unit.os, 'lstat', side_effect=OSError('missing')):
            with self.assertRaises(unit.UnitError):
                unit._check_trusted_executable('/a/exec')

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze unavailable')
    def test_systemd_verify_private_fixture(self):
        # Replace only the missing, deployment-specific entry point with a real
        # harmless executable. This verifies syntax, not deployment readiness.
        with mock.patch.object(unit, '_check_trusted_executable'):
            text = unit.generate_unit().replace(unit.EXECUTABLE, '/usr/bin/true')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pi-chat-username-recovery.service'
            path.write_text(text)
            result = subprocess.run(['systemd-analyze', 'verify', str(path)],
                                    capture_output=True, text=True, timeout=20,
                                    env={**os.environ, 'SYSTEMD_UNIT_PATH': tmp + ':'})
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
