"""Unit and disposable local PostgreSQL tests. Never connect to an external server."""
import copy
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest

from username_migration_role_restore_sql import RoleRecordError, role_restore_sql

ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))
BIN = Path(os.environ.get('TEST_PG_BIN', str(ROOT / 'bin')))
LIB = Path(os.environ.get('TEST_PG_LIB', str(ROOT / 'lib64')))
SHARE = Path(os.environ.get('TEST_PG_SHARE', str(ROOT / 'share/pgsql')))


def record():
    return dict(rolinherit=True, rolcreatedb=False, rolcreaterole=False,
                rolcanlogin=True, rolreplication=False, rolbypassrls=False,
                rolconnlimit=-1, rolvaliduntil=None, rolpassword=None, settings={})


class GeneratorTest(unittest.TestCase):
    def test_rejections(self):
        for role in ('bad"role', 'x; DROP ROLE x', '', 'é'):
            with self.assertRaises(RoleRecordError):
                role_restore_sql(role, record())
        for key, value in [('rolcanlogin', False), ('rolconnlimit', True),
                           ('rolpassword', "md5' OR true"), ('rolvaliduntil', '\x00'),
                           ('settings', {'search_path': '\x00'}),
                           ('settings', {'search_path;drop': 'x'}),
                           ('settings', {'timezone': '\ud800'}),
                           ('settings', {'timezone': 'UTC', 'TimeZone': 'UTC'})]:
            item = record(); item[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RoleRecordError):
                role_restore_sql('target', item)
        item = record(); item['rolsuper'] = True
        with self.assertRaises(RoleRecordError):
            role_restore_sql('target', item)

    def test_raw_adversarial_text_absent(self):
        item = record(); item['settings'] = {'search_path': "\\'; DROP ROLE target; --"}
        item['rolvaliduntil'] = "\\'; DROP ROLE target; --"
        result = role_restore_sql('target', item)
        self.assertNotIn(item['settings']['search_path'], result)
        self.assertNotIn(item['rolvaliduntil'], result)


@unittest.skipUnless((BIN / 'initdb').exists() and (BIN / 'psql').exists(), 'isolated PostgreSQL binaries unavailable')
class PostgresTest(unittest.TestCase):
    def test_disposable_cluster(self):
        env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
               'LD_LIBRARY_PATH': str(LIB), 'PGCONNECT_TIMEOUT': '2',
               'PGOPTIONS': '-c search_path=pg_catalog -c standard_conforming_strings=off'}
        def run(program, *args, input=None, check=True):
            return subprocess.run([str(BIN / program), *args], env=env, input=input,
                                  text=True, capture_output=True, check=check, timeout=45)
        with tempfile.TemporaryDirectory(prefix='role-sql-test-') as temp:
            root = Path(temp); data = root / 'data'; sock = root / 'socket'; sock.mkdir(mode=0o700)
            with socket.socket() as s:
                s.bind(('127.0.0.1', 0)); port = str(s.getsockname()[1])
            run('initdb', '-L', str(SHARE), '-D', str(data), '-U', 'test_admin', '--auth-local=trust', '--no-locale')
            run('pg_ctl', '-D', str(data), '-l', str(root / 'log'), '-o', f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start')
            def sql(query, check=True):
                return run('psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', port, '-U', 'test_admin', '-d', 'postgres', input=query, check=check)
            try:
                sql('CREATE ROLE target LOGIN;')
                item = record(); item.update(rolcreatedb=True, rolinherit=False, rolconnlimit=7,
                    rolpassword='md5' + 'a' * 32,
                    settings={'search_path': '"x\\y", "a\'b"', 'TimeZone': 'UTC'})
                sql(role_restore_sql('target', item))
                output = sql("SELECT rolcreatedb,rolinherit,rolconnlimit,rolpassword,rolvaliduntil IS NULL FROM pg_catalog.pg_authid WHERE rolname='target';").stdout.strip()
                self.assertEqual(output, 't|f|7|md5' + 'a' * 32 + '|t')
                settings = sql("SELECT pg_catalog.array_to_json(setconfig) FROM pg_catalog.pg_db_role_setting WHERE setrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='target') AND setdatabase=0;").stdout
                import json
                self.assertEqual(set(json.loads(settings)), {'search_path=' + item['settings']['search_path'], 'TimeZone=UTC'})
                sql("ALTER ROLE target VALID UNTIL '2030-01-01';")
                result = sql(role_restore_sql('target', record()), check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(sql("SELECT rolcreatedb FROM pg_catalog.pg_authid WHERE rolname='target';").stdout.strip(), 't')
                item2 = copy.deepcopy(item); item2['rolvaliduntil'] = '2040-01-01 00:00:00+00'; item2['rolpassword'] = None; item2['settings'] = {}
                sql(role_restore_sql('target', item2))
                self.assertEqual(sql("SELECT rolpassword IS NULL, rolvaliduntil = '2040-01-01 00:00:00+00'::timestamptz FROM pg_catalog.pg_authid WHERE rolname='target';").stdout.strip(), 't|t')
                bad = copy.deepcopy(item2); bad['rolvaliduntil'] = "\\'; DROP ROLE target; --"
                self.assertNotEqual(sql(role_restore_sql('target', bad), check=False).returncode, 0)
                self.assertEqual(sql("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname='target';").stdout.strip(), '1')
            finally:
                run('pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop')


if __name__ == '__main__':
    unittest.main()
