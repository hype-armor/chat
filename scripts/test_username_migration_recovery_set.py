import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import username_migration_recovery_set as recovery


class RecoverySetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.args = {'output': str(self.root / 'set'), 'blob_backup_required': False}
        for key in ('database_archive', 'postgres_globals', 'postgres_settings',
                    'compose_config', 'image_identifiers', 'environment', 'seaweed_inventory'):
            path = self.root / key
            path.write_bytes(b'{"synthetic":true}')
            self.args[key] = str(path)

    def test_private_manifest_and_no_overwrite(self):
        recovery.create(**self.args)
        out = self.root / 'set'
        self.assertEqual(out.stat().st_mode & 0o777, 0o700)
        for path in out.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        manifest = json.loads((out / 'manifest.json').read_text())
        self.assertFalse(manifest['restore_authorized'])
        self.assertFalse(manifest['scope_verified'])
        self.assertEqual(len(manifest['files']), 7)
        with self.assertRaises(FileExistsError):
            recovery.create(**self.args)

    def test_required_blob_fails_before_output(self):
        self.args['blob_backup_required'] = True
        with self.assertRaisesRegex(recovery.RecoverySetError, 'no atomic'):
            recovery.create(**self.args)
        self.assertFalse((self.root / 'set').exists())

    def test_symlink_input_and_parent_refused(self):
        link = self.root / 'link'
        link.symlink_to(self.args['environment'])
        self.args['environment'] = str(link)
        with self.assertRaises(OSError):
            recovery.create(**self.args)
        self.args['environment'] = str(self.root / 'environment')
        link.unlink()
        link.symlink_to(self.root, target_is_directory=True)
        self.args['output'] = str(link / 'set')
        with self.assertRaises(OSError):
            recovery.create(**self.args)

    def test_interruption_never_publishes_manifest(self):
        original = recovery._publish
        def interrupted(fd, name, data):
            if name == 'postgres-settings.json':
                raise KeyboardInterrupt()
            return original(fd, name, data)
        with mock.patch.object(recovery, '_publish', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                recovery.create(**self.args)
        self.assertFalse((self.root / 'set' / 'manifest.json').exists())
        with self.assertRaises(FileExistsError):
            recovery.create(**self.args)

    def test_write_failure_never_publishes_manifest(self):
        with mock.patch.object(recovery.os, 'write', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                recovery.create(**self.args)
        self.assertFalse((self.root / 'set' / 'manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
