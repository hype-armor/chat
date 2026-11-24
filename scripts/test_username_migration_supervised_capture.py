#!/usr/bin/env python3
"""Test supervised capture with disposable local PostgreSQL clusters only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import isolated_pg_supervisor
import username_migration_backup_manifest as manifest

ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))


class SupervisedCaptureTest(unittest.TestCase):
    def test_capture_and_endpoint_failure(self):
        with tempfile.TemporaryDirectory(prefix='supervised-capture-') as tmp:
            base = Path(tmp)
            archives = base / 'archives'
            archives.mkdir(mode=0o700)
            params = dict(bindir=str(ROOT / 'bin'), share=str(ROOT / 'share/pgsql'),
                          library_path=str(ROOT / 'lib64'), parent=str(base))
            with isolated_pg_supervisor.IsolatedPostgres(**params) as source, \
                 isolated_pg_supervisor.IsolatedPostgres(**params) as target:
                source.run('createdb', ['appdb'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                source.run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', 'appdb', '-c',
                           'CREATE TABLE sample (id int); INSERT INTO sample VALUES (42)'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                source.run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-c',
                           "ALTER DATABASE appdb SET timezone TO 'UTC'"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                filename = manifest.capture_and_verify_supervised(source=source, validation=target,
                                                                  database='appdb', directory=str(archives))
                evidence = json.loads((archives / filename).read_text())
                backup = archives / evidence['archive']
                self.assertEqual(evidence['sha256'], hashlib.sha256(backup.read_bytes()).hexdigest())
                self.assertTrue(evidence['validation']['database_object_restore_completed'])
                self.assertTrue(evidence['validation']['database_create_restore_completed'])
                self.assertTrue(evidence['validation']['selected_database_properties_compared'])
                self.assertIn('TimeZone=UTC', evidence['selected_database_properties']['settings'][0]['config'])
                self.assertFalse(evidence['validation']['database_properties_compared'])
                self.assertFalse(evidence['operational_restore_authorized'])
                manifest_digest = hashlib.sha256((archives / filename).read_bytes()).hexdigest()
                args = dict(directory=str(archives), manifest_name=filename,
                            expected_manifest_sha256=manifest_digest,
                            expected_system_id=evidence['source']['system_id'],
                            expected_database='appdb', expected_role=evidence['source']['role'])
                with self.assertRaises(ValueError):
                    manifest.open_supervised_snapshot(**dict(args, expected_manifest_sha256='0' * 64))
                with self.assertRaises(ValueError):
                    manifest.open_supervised_snapshot(**dict(args, expected_database='other'))
                altered = dict(evidence, validation=dict(evidence['validation'], system_id=None))
                altered_path = archives / 'altered_manifest'
                altered_path.write_text(json.dumps(altered))
                altered_path.chmod(0o600)
                with self.assertRaises(ValueError):
                    manifest.open_supervised_snapshot(**dict(args, manifest_name=altered_path.name,
                        expected_manifest_sha256=hashlib.sha256(altered_path.read_bytes()).hexdigest()))
                altered_path.unlink()
                archive_bytes = backup.read_bytes()
                snapshot, loaded = manifest.open_supervised_snapshot(**args)
                try:
                    backup.write_bytes(b'mutated after snapshot')
                    self.assertEqual(hashlib.sha256(os.read(snapshot, len(archive_bytes) + 1)).hexdigest(), evidence['sha256'])
                    self.assertEqual(loaded['source']['system_id'], evidence['source']['system_id'])
                finally:
                    os.close(snapshot)
                    backup.write_bytes(archive_bytes)
                before = set(p.name for p in archives.iterdir())
                target.run('createdb', ['appdb'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                with self.assertRaises(ValueError):
                    manifest.capture_and_verify_supervised(source=source, validation=target,
                                                           database='appdb', directory=str(archives))
                result = target.run('psql', ['-X', '-qAt', '-c',
                                    "SELECT count(*) FROM pg_database WHERE datname='appdb'"],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                self.assertEqual(result.stdout.strip(), b'1')
                target.run('dropdb', ['appdb'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.assertEqual(set(p.name for p in archives.iterdir()), before)
                real_run = target.run
                def fail_restore(program, args, **kwargs):
                    if program == 'pg_restore':
                        raise isolated_pg_supervisor.EndpointError('synthetic endpoint failure')
                    return real_run(program, args, **kwargs)
                with mock.patch.object(target, 'run', side_effect=fail_restore):
                    with self.assertRaises(isolated_pg_supervisor.EndpointError):
                        manifest.capture_and_verify_supervised(source=source, validation=target,
                                                               database='appdb', directory=str(archives))
                self.assertEqual(set(p.name for p in archives.iterdir()), before)


if __name__ == '__main__':
    unittest.main()
