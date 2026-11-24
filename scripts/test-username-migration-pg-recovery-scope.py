#!/usr/bin/env python3
"""Probe recovery scope assumptions on a disposable, socket-only PostgreSQL.

These are catalog and isolation experiments, not tests of an implemented
scope validator. The current recovery module deliberately cannot restore.
Run: python3 scripts/test-username-migration-pg-recovery-scope.py
"""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('recovery', HERE / 'username-migration-pg-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class DisposableScopeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.geteuid() == 0:
            raise unittest.SkipTest('PostgreSQL initdb must run as an unprivileged user')
        if not (ROOT / 'bin/initdb').is_file():
            raise unittest.SkipTest(f'isolated PostgreSQL distribution is missing: {ROOT}')
        cls.tmp = tempfile.TemporaryDirectory(prefix='pg-scope-test-')
        cls.base = Path(cls.tmp.name)
        cls.running = False
        try:
            # A private copy permits a test extension without touching the source
            # installation or any deployment. Its SQL creates no external files.
            cls.usr = cls.base / 'usr'
            shutil.copytree(ROOT, cls.usr, symlinks=True)
            ext = cls.usr / 'share/pgsql/extension'
            (ext / 'scope_probe.control').write_text("default_version = '1.0'\nrelocatable = true\n")
            (ext / 'scope_probe--1.0.sql').write_text('CREATE TABLE scope_probe_marker (id integer);\n')
            cls.data = cls.base / 'data'
            cls.sock = cls.base / 'socket'
            cls.sock.mkdir(mode=0o700)
            cls.env = {'PATH': '/usr/bin:/bin', 'HOME': str(cls.base), 'LC_ALL': 'C',
                       'LD_LIBRARY_PATH': str(cls.usr / 'lib64'), 'PGCONNECT_TIMEOUT': '2'}
            cls.run_pg('initdb', '-L', str(cls.usr / 'share/pgsql'), '-D', str(cls.data),
                       '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale')
            # A failed or timed-out start can still leave a server running.
            # Mark it before the call, so cleanup never deletes live data.
            cls.running = True
            cls.run_pg('pg_ctl', '-D', str(cls.data), '-l', str(cls.base / 'log'),
                       '-o', f"-k {cls.sock} -p 55442 -c listen_addresses=''", '-w', 'start')
        except BaseException:
            cls.cleanup_cluster()
            raise

    @classmethod
    def cleanup_cluster(cls):
        try:
            if cls.running:
                cls.run_pg('pg_ctl', '-D', str(cls.data), '-m', 'fast', '-w', 'stop')
                cls.running = False
        finally:
            # Do not delete a data directory if the server could still be running.
            if not cls.running:
                cls.tmp.cleanup()
            else:
                # Preserve the directory even if TemporaryDirectory is collected.
                cls.tmp._finalizer.detach()

    @classmethod
    def tearDownClass(cls):
        cls.cleanup_cluster()

    @classmethod
    def run_pg(cls, program, *args, input=None):
        return subprocess.run([str(cls.usr / 'bin' / program), *args], input=input,
                              text=True, capture_output=True, env=cls.env, check=True, timeout=60)

    def sql(self, query, db='postgres'):
        result = self.run_pg('psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                             '-h', str(self.sock), '-p', '55442', '-U', 'postgres',
                             '-d', db, input=query)
        return result.stdout.strip().splitlines()

    def test_server_is_private_and_socket_only(self):
        self.assertEqual(self.sql("SELECT current_setting('listen_addresses'), current_setting('unix_socket_directories');"),
                         ['|' + str(self.sock)])
        self.assertEqual(self.sock.stat().st_mode & 0o777, 0o700)
        self.assertTrue((self.sock / '.s.PGSQL.55442').is_socket())
        self.assertEqual(self.sql('SELECT current_user, current_database();'), ['postgres|postgres'])

    def test_database_inventory_includes_nonconnectable_databases(self):
        baseline = set(self.sql('SELECT datname FROM pg_database;'))
        self.assertTrue({'postgres', 'template0', 'template1'} <= baseline)
        try:
            self.sql('CREATE DATABASE scope_extra;')
            self.sql('ALTER DATABASE scope_extra ALLOW_CONNECTIONS false;')
            all_databases = set(self.sql('SELECT datname FROM pg_database;'))
            connectable = set(self.sql('SELECT datname FROM pg_database WHERE datallowconn;'))
            self.assertEqual(all_databases - baseline, {'scope_extra'})
            self.assertNotIn('scope_extra', connectable)
        finally:
            self.sql('DROP DATABASE IF EXISTS scope_extra;')

    def test_role_inventory_includes_nologin_roles(self):
        baseline = set(self.sql('SELECT rolname FROM pg_roles;'))
        try:
            self.sql('CREATE ROLE scope_nologin NOLOGIN; CREATE ROLE scope_login LOGIN;')
            all_roles = set(self.sql('SELECT rolname FROM pg_roles;'))
            login_roles = set(self.sql('SELECT rolname FROM pg_roles WHERE rolcanlogin;'))
            self.assertEqual(all_roles - baseline, {'scope_nologin', 'scope_login'})
            self.assertIn('scope_login', login_roles)
            self.assertNotIn('scope_nologin', login_roles)
        finally:
            self.sql('DROP ROLE IF EXISTS scope_nologin; DROP ROLE IF EXISTS scope_login;')

    def test_extensions_are_per_database_and_include_defaults(self):
        try:
            self.sql('CREATE DATABASE scope_extensions;')
            default = set(self.sql('SELECT extname FROM pg_extension;'))
            self.assertIn('plpgsql', default)
            self.assertEqual(set(self.sql('SELECT extname FROM pg_extension;', 'scope_extensions')), default)
            self.sql('CREATE EXTENSION scope_probe;', 'scope_extensions')
            self.assertEqual(set(self.sql('SELECT extname FROM pg_extension;', 'scope_extensions')) - default,
                             {'scope_probe'})
            self.assertEqual(set(self.sql('SELECT extname FROM pg_extension;')), default)
        finally:
            self.sql('DROP DATABASE IF EXISTS scope_extensions;')

    def test_restore_remains_unavailable(self):
        with self.assertRaises(recovery.RecoveryUnavailable):
            recovery.restore_database()


if __name__ == '__main__':
    unittest.main(verbosity=2)
