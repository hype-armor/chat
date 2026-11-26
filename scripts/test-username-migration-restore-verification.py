#!/usr/bin/env python3
"""Verify restores on separate synthetic PostgreSQL clusters, never production."""
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('recovery', HERE / 'username-migration-pg-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))
BIN = ROOT / 'bin'
ENV = dict(os.environ, LD_LIBRARY_PATH=str(ROOT / 'lib64'))


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class VerifyRestoreTest(unittest.TestCase):
    def test_real_restore_and_corrupt_archive(self):
        with tempfile.TemporaryDirectory(prefix='pg-verify-restore-') as tmp:
            base = Path(tmp)
            archive = base / 'archives'
            archive.mkdir(mode=0o700)
            servers = []
            try:
                for label in ('source', 'target'):
                    root = base / label
                    root.mkdir()
                    data, sock = root / 'data', root / 'socket'
                    sock.mkdir(mode=0o700)
                    port = free_port()
                    subprocess.run([str(BIN / 'initdb'), '-L', str(ROOT / 'share/pgsql'), '-D', str(data), '-A', 'trust', '--no-locale', '-U', 'postgres'], env=ENV, check=True, capture_output=True)
                    subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-l', str(root / 'log'), '-o', f"-k {sock} -p {port} -c listen_addresses=''", '-w', 'start'], env=ENV, check=True, capture_output=True)
                    servers.append((data, sock, port))
                _, source, source_port = servers[0]
                _, target, target_port = servers[1]
                subprocess.run([str(BIN / 'psql'), '-h', str(source), '-p', str(source_port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE ROLE sampleowner NOLOGIN; CREATE TABLE sample (id integer); INSERT INTO sample VALUES (42); ALTER TABLE sample OWNER TO sampleowner; REVOKE ALL ON sample FROM PUBLIC"], env=ENV, check=True, capture_output=True)
                recovery.capture_database(bindir=str(BIN), socket=str(source), port=source_port, user='postgres', database='postgres', directory=str(archive), name='backup', library_path=str(ROOT / 'lib64'))
                args = dict(bindir=str(BIN), socket=str(target), port=target_port, user='postgres', directory=str(archive), name='backup', library_path=str(ROOT / 'lib64'))
                # Preserve ownership: a missing role must fail, not silently
                # succeed via --no-owner or --no-privileges.
                with self.assertRaises(subprocess.CalledProcessError):
                    recovery.verify_database_restore(**args)
                subprocess.run([str(BIN / 'psql'), '-h', str(target), '-p', str(target_port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE ROLE sampleowner NOLOGIN'], env=ENV, check=True, capture_output=True)
                recovery.verify_database_restore(**args)
                # A corrupt archive must fail and its temporary database must be removed.
                bad = archive / 'corrupt'
                bad.write_bytes((archive / 'backup').read_bytes()[:64])
                bad.chmod(0o600)
                args['name'] = 'corrupt'
                with self.assertRaises(subprocess.CalledProcessError):
                    recovery.verify_database_restore(**args)
                remaining = subprocess.run([str(BIN / 'psql'), '-h', str(target), '-p', str(target_port), '-U', 'postgres', '-d', 'postgres', '-At', '-c', "SELECT count(*) FROM pg_database WHERE datname LIKE 'chat_verify_%'"], env=ENV, text=True, capture_output=True, check=True)
                self.assertEqual(remaining.stdout.strip(), '0')
            finally:
                for data, _, _ in reversed(servers):
                    subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', 'stop'], env=ENV, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
