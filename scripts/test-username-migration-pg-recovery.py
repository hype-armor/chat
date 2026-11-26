#!/usr/bin/env python3
"""Synthetic local PostgreSQL checks; never accesses a deployment."""
import importlib.util
import os
from pathlib import Path
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


class RecoveryTest(unittest.TestCase):
    def test_restore_fails_closed(self):
        with self.assertRaises(recovery.RecoveryUnavailable):
            recovery.restore_database()

    def test_real_capture_and_no_overwrite(self):
        with tempfile.TemporaryDirectory(prefix='pg-recovery-test-') as tmp:
            base = Path(tmp)
            data, socket, archives = base / 'data', base / 'socket', base / 'archives'
            socket.mkdir(mode=0o700)
            archives.mkdir(mode=0o700)
            subprocess.run([str(BIN / 'initdb'), '-L', str(ROOT / 'share/pgsql'), '-D', str(data), '-A', 'trust', '--no-locale', '-U', 'postgres'], env=ENV, check=True, capture_output=True)
            subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-l', str(base / 'log'), '-o', f"-k {socket} -p 55442 -c listen_addresses=''", '-w', 'start'], env=ENV, check=True, capture_output=True)
            try:
                subprocess.run([str(BIN / 'psql'), '-h', str(socket), '-p', '55442', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE TABLE sample (id int); INSERT INTO sample VALUES (42)"], env=ENV, check=True, capture_output=True)
                args = dict(bindir=str(BIN), socket=str(socket), port=55442, user='postgres', database='postgres', directory=str(archives), name='backup', library_path=str(ROOT / 'lib64'))
                recovery.capture_database(**args)
                original = (archives / 'backup').read_bytes()
                self.assertTrue(original.startswith(b'PGDMP'))
                self.assertEqual((archives / 'backup').stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    recovery.capture_database(**args)
                self.assertEqual(original, (archives / 'backup').read_bytes())
                # Find a truncated archive whose catalog is still readable but
                # whose data cannot be decoded. A catalog-only check misses it.
                corrupt = base / 'corrupt'
                for cut in range(1, len(original)):
                    corrupt.write_bytes(original[:-cut])
                    listing = subprocess.run([str(BIN / 'pg_restore'), '--list', str(corrupt)], env=ENV, capture_output=True)
                    decoding = subprocess.run([str(BIN / 'pg_restore'), '--file=-', str(corrupt)], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if listing.returncode == 0 and decoding.returncode != 0:
                        break
                else:
                    self.fail('could not construct catalog-readable corrupted dump')
                fake_bin = base / 'fake-bin'
                fake_bin.mkdir()
                (fake_bin / 'pg_restore').symlink_to(BIN / 'pg_restore')
                fake_dump = fake_bin / 'pg_dump'
                fake_dump.write_text('#!/bin/sh\nexec /bin/cat "' + str(corrupt) + '"\n')
                fake_dump.chmod(0o700)
                corrupt_args = dict(args, bindir=str(fake_bin), name='corrupted')
                with self.assertRaises(subprocess.CalledProcessError):
                    recovery.capture_database(**corrupt_args)
                self.assertFalse((archives / 'corrupted').exists())
                args['database'] = 'missing_database'
                args['name'] = 'failed'
                with self.assertRaises(subprocess.CalledProcessError):
                    recovery.capture_database(**args)
                self.assertEqual(sorted(p.name for p in archives.iterdir()), ['backup'])
            finally:
                subprocess.run([str(BIN / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'], env=ENV, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
