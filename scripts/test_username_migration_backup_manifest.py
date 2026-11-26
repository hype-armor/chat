#!/usr/bin/env python3
"""Integration test with disposable local PostgreSQL clusters only."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest import mock

import username_migration_backup_manifest as manifest

ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))
BIN = ROOT / 'bin'
ENV = dict(os.environ, LD_LIBRARY_PATH=str(ROOT / 'lib64'))


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class ManifestTest(unittest.TestCase):
    def test_full_restore_and_fail_closed(self):
        servers = []
        with tempfile.TemporaryDirectory(prefix='manifest-test-') as tmp:
            base = Path(tmp)
            backups = base / 'backups'
            backups.mkdir(mode=0o700)
            try:
                for label in ('source', 'target'):
                    root = base / label
                    root.mkdir()
                    data, sock = root / 'data', root / 'sock'
                    sock.mkdir(mode=0o700)
                    p = port()
                    subprocess.run([str(BIN / 'initdb'), '-L', str(ROOT / 'share/pgsql'), '-D', str(data), '-A', 'trust', '--no-locale', '-U', 'postgres'], env=ENV, check=True, capture_output=True)
                    subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-l', str(root / 'log'), '-o', f"-k {sock} -p {p} -c listen_addresses=''", '-w', 'start'], env=ENV, check=True, capture_output=True)
                    servers.append((data, sock, p))
                _, source, sp = servers[0]
                _, target, tp = servers[1]
                def sql(sock, p, statement):
                    subprocess.run([str(BIN / 'psql'), '-h', str(sock), '-p', str(p), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', statement], env=ENV, check=True, capture_output=True)
                sql(source, sp, "ALTER ROLE postgres PASSWORD 'synthetic-test-password'; CREATE ROLE sampleowner NOLOGIN; CREATE TABLE sample (id integer); INSERT INTO sample VALUES (42); ALTER TABLE sample OWNER TO sampleowner;")
                with (backups / 'backup').open('wb') as out:
                    os.fchmod(out.fileno(), 0o600)
                    subprocess.run([str(BIN / 'pg_dump'), '-h', str(source), '-p', str(sp), '-U', 'postgres', '-Fc', 'postgres'], env=ENV, stdout=out, check=True)
                args = dict(bindir=str(BIN), source_socket=str(source), source_port=sp,
                            validation_socket=str(target), validation_port=tp, role='postgres',
                            database='postgres', directory=str(backups), archive='backup',
                            library_path=str(ROOT / 'lib64'))
                with self.assertRaises(manifest.pg.RestoreError):
                    manifest.create_manifest(**args)
                self.assertEqual(sorted(x.name for x in backups.iterdir()), ['backup'])
                sql(target, tp, 'CREATE ROLE sampleowner NOLOGIN')
                name = manifest.create_manifest(**args)
                record = json.loads((backups / name).read_text())
                self.assertEqual(record['sha256'], hashlib.sha256((backups / record['archive']).read_bytes()).hexdigest())
                self.assertTrue(record['validation']['database_object_restore_completed'])
                self.assertTrue(record['validation']['owner_acl_commands_not_skipped'])
                self.assertFalse(record['validation']['database_properties_compared'])
                self.assertFalse(record['validation']['source_completeness_proved'])
                self.assertFalse(record['operational_restore_authorized'])
                self.assertNotEqual(record['source']['system_id'], record['validation']['system_id'])
                self.assertEqual(record['source']['database']['datname'], 'postgres')
                self.assertEqual(record['source']['role_record']['rolname'], 'postgres')
                self.assertRegex(record['source']['role_record']['rolpassword'], r'^(SCRAM-SHA-256\$|md5)')
                self.assertIn('evidence_created_at', record)
                # A failed publication must not expose a new final manifest.
                before = set(p.name for p in backups.iterdir())
                with mock.patch.object(manifest.os, 'link', side_effect=OSError('simulated publication failure')):
                    with self.assertRaises(OSError):
                        manifest.create_manifest(**args)
                self.assertEqual(set(p.name for p in backups.iterdir()), before)
                # Capture itself must run pg_dump against the recorded source,
                # then test the exact resulting archive on the other cluster.
                capture_args = dict(args)
                capture_args.pop('archive')
                evidence_name = manifest.capture_and_verify(**capture_args)
                evidence = json.loads((backups / evidence_name).read_text())
                captured_record = json.loads((backups / evidence['manifest']).read_text())
                self.assertEqual(evidence['sha256'], captured_record['sha256'])
                self.assertEqual(evidence['source_system_id'], captured_record['source']['system_id'])
                self.assertEqual(evidence['sha256'], hashlib.sha256((backups / captured_record['archive']).read_bytes()).hexdigest())
                self.assertFalse(evidence['operational_restore_authorized'])
                self.assertIn('capture_started_at', evidence)
                self.assertFalse(any(p.name.startswith('capture_') and not p.name.startswith('capture_evidence_') for p in backups.iterdir()))
                bad = backups / 'bad'
                bad.write_bytes((backups / 'backup').read_bytes()[:64])
                bad.chmod(0o600)
                with self.assertRaises(manifest.pg.RestoreError):
                    manifest.create_manifest(**dict(args, archive='bad'))
                self.assertEqual((backups / name).stat().st_mode & 0o777, 0o600)
                with self.assertRaises(ValueError):
                    manifest.create_manifest(**dict(args, validation_socket=str(source), validation_port=sp))
                (backups / 'link').symlink_to('backup')
                with self.assertRaises(OSError):
                    manifest.create_manifest(**dict(args, archive='link'))
                (backups / 'backup').chmod(0o644)
                with self.assertRaises(ValueError):
                    manifest.create_manifest(**args)
            finally:
                for data, _, _ in reversed(servers):
                    subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', 'stop'], env=ENV, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
