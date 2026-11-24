"""Destructive tests use only a fresh, locally supervised synthetic cluster."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from username_migration_docker_pg_restore_testonly import RestoreError, TestOnlyPostgresRestore
from username_migration_docker_pg_restore_check import _PROPERTIES_SQL

BASE = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr')).parent
BIN = Path(os.environ.get('TEST_PG_BIN', BASE / 'usr/bin'))
LIB = Path(os.environ.get('TEST_PG_LIB', BASE / 'usr/lib64'))
SHARE = Path(os.environ.get('TEST_PG_SHARE', BASE / 'usr/share/pgsql'))


@unittest.skipUnless((BIN / 'initdb').exists(), 'isolated PostgreSQL binaries unavailable')
class DisposableRestore(unittest.TestCase):
    def test_interrupted_restores_can_retry(self):
        env = dict(os.environ, PATH=str(BIN) + os.pathsep + os.environ['PATH'],
                   LD_LIBRARY_PATH=str(LIB), PGCONNECT_TIMEOUT='2')
        env.pop('PGPASSWORD', None)
        with tempfile.TemporaryDirectory(prefix='pg-restore-disposable-') as tmp:
            root = Path(tmp)
            data = root / 'data'
            archive_dir = root / 'archive'
            archive_dir.mkdir(mode=0o700)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = str(sock.getsockname()[1])
            def process(args, **kwargs):
                return subprocess.run(args, env=env, check=True, timeout=30,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
            process(['initdb', '-D', str(data), '-L', str(SHARE),
                     '-U', 'app', '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale'])
            running = False
            try:
                process(['pg_ctl', '-D', str(data), '-l', str(root / 'log'), '-o',
                         f"-c listen_addresses='' -k {root} -p {port}", '-w', 'start'])
                running = True
                conn = ['-h', str(root), '-p', port, '-U', 'app']
                process(['createdb', *conn, 'appdb'])
                process(['psql', *conn, '-d', 'appdb', '-c', 'CREATE TABLE marker (n integer); INSERT INTO marker VALUES (42)'])
                process(['psql', *conn, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
                         "COMMENT ON DATABASE appdb IS 'synthetic comment'; "
                         "ALTER DATABASE appdb CONNECTION LIMIT 12; "
                         "REVOKE CONNECT ON DATABASE appdb FROM PUBLIC; "
                         "ALTER DATABASE appdb SET work_mem TO '8MB'; "
                         "ALTER ROLE app IN DATABASE appdb SET timezone TO 'UTC'"])
                def database_properties():
                    return json.loads(process(['psql', *conn, '-d', 'appdb', '-X', '-qAt'], input=_PROPERTIES_SQL).stdout)
                def observed_properties():
                    def query(sql):
                        return process(['psql', *conn, '-d', 'postgres', '-X', '-qAt',
                                        '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.decode().strip()
                    return {
                        'comment': query("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname='appdb'"),
                        'connection_limit': query("SELECT datconnlimit FROM pg_database WHERE datname='appdb'"),
                        'public_connect': query("SELECT EXISTS (SELECT 1 FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname='appdb' AND a.grantee=0 AND a.privilege_type='CONNECT')"),
                        'acl': query("SELECT COALESCE(grantee.rolname, 'PUBLIC'), grantor.rolname, a.privilege_type, a.is_grantable FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a LEFT JOIN pg_roles grantee ON grantee.oid=a.grantee JOIN pg_roles grantor ON grantor.oid=a.grantor WHERE d.datname='appdb' ORDER BY 1, 2, 3, 4"),
                        'settings': query("SELECT COALESCE(r.rolname, ''), unnest(s.setconfig) FROM pg_db_role_setting s JOIN pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_roles r ON r.oid=s.setrole WHERE d.datname='appdb' ORDER BY 1, 2"),
                    }
                def assert_observed(comment, limit, public_connect, work_mem, timezone):
                    observed = observed_properties()
                    self.assertEqual(observed['comment'], comment)
                    self.assertEqual(observed['connection_limit'], str(limit))
                    self.assertEqual(observed['public_connect'], public_connect)
                    self.assertEqual(observed['settings'].splitlines(),
                                     [f'|work_mem={work_mem}', f'app|TimeZone={timezone}'])
                def change_properties():
                    process(['psql', *conn, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
                             "COMMENT ON DATABASE appdb IS 'changed'; "
                             "ALTER DATABASE appdb CONNECTION LIMIT 5; "
                             "GRANT CONNECT ON DATABASE appdb TO PUBLIC; "
                             "ALTER DATABASE appdb SET work_mem TO '4MB'; "
                             "ALTER ROLE app IN DATABASE appdb SET timezone TO 'Europe/Paris'"])
                    assert_observed('changed', 5, 't', '4MB', 'Europe/Paris')
                    self.assertNotEqual(observed_properties()['acl'], original_acl)
                def assert_restored():
                    self.assertEqual(database_properties(), properties)
                    assert_observed('synthetic comment', 12, 'f', '8MB', 'UTC')
                    self.assertEqual(observed_properties()['acl'], original_acl)
                original_acl = observed_properties()['acl']
                properties = database_properties()
                assert_observed('synthetic comment', 12, 'f', '8MB', 'UTC')
                self.assertEqual(properties['comment'], 'synthetic comment')
                self.assertEqual(properties['connection_limit'], 12)
                self.assertFalse(any(a['grantee'] == 'PUBLIC' and a['privilege'] == 'CONNECT'
                                     for a in properties['acl']))
                self.assertTrue(any(s['role'] == '' and 'work_mem=8MB' in s['config']
                                    for s in properties['settings']))
                self.assertTrue(any(s['role'] == 'app' and 'TimeZone=UTC' in s['config']
                                    for s in properties['settings']))
                dump = process(['pg_dump', *conn, '-Fc', '-C', 'appdb']).stdout
                change_properties()
                changed = database_properties()
                for key in ('comment', 'connection_limit', 'acl', 'settings'):
                    self.assertNotEqual(changed[key], properties[key])
                archive = archive_dir / 'postgres.dump'
                archive.write_bytes(dump)
                archive.chmod(0o600)
                identity = process(['psql', *conn, '-d', 'postgres', '-X', '-qAt', '-c',
                                    'SELECT system_identifier::text FROM pg_control_system()']).stdout.decode().strip()
                fd = os.open(archive_dir, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    failure = [None]
                    def fence(phase, binding):
                        if phase == failure[0]:
                            failure[0] = None
                            return False
                        return True
                    def runner(args, **kwargs):
                        command = args[args.index('exec') + 5:]
                        if failure[0] == 'sessions_remain' and b'SELECT count(*) FROM pg_catalog.pg_stat_activity' in kwargs.get('input', b''):
                            failure[0] = None
                            return subprocess.CompletedProcess(args, 0, b'1\n')
                        if failure[0] == 'after_drop' and command[0] == 'pg_restore' and '--create' in command:
                            process(['dropdb', *conn, '--if-exists', 'appdb'])
                            failure[0] = None
                            raise RuntimeError('injected after drop')
                        if command[0] == 'psql' or (command[0] == 'pg_restore' and '--create' in command):
                            command = command[:1] + ['-h', str(root), '-p', port] + command[1:]
                        kwargs['env'] = dict(env, PGOPTIONS='-c search_path=pg_catalog -c standard_conforming_strings=on')
                        if failure[0] == 'inside_role' and kwargs.get('input', b'').startswith(b'BEGIN;\nDO $role_restore$'):
                            failure[0] = None
                            kwargs['input'] = kwargs['input'].replace(b'COMMIT;', b'SELECT 1/0;\nCOMMIT;')
                        return subprocess.run(command, **kwargs)
                    with patch('username_migration_docker_pg_restore_testonly._disk_directory'):
                        adapter = TestOnlyPostgresRestore(directory_fd=fd, source_system_identifier=identity,
                            operation='operation_123456', role='app', database='appdb',
                            archive_sha256=hashlib.sha256(dump).hexdigest(), container_id='a' * 64,
                            verify_rollback_fence=fence)
                        # Use a row that differs from the archive, so replacement cannot
                        # appear to preserve the live database merely by restoring 42.
                        process(['psql', *conn, '-d', 'appdb', '-c', 'UPDATE marker SET n=99'])
                        def scope_state():
                            query = lambda sql: process(['psql', *conn, '-d', 'postgres', '-X', '-qAt',
                                                         '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout
                            return (query("SELECT oid, datallowconn FROM pg_database WHERE datname='appdb'"),
                                    query("SELECT oid, rolname, rolsuper, rolcanlogin, rolconnlimit, "
                                          "rolvaliduntil, rolpassword FROM pg_authid ORDER BY oid"),
                                    query("SELECT roleid, member, grantor, admin_option FROM pg_auth_members "
                                          "ORDER BY roleid, member, grantor"),
                                    process(['psql', *conn, '-d', 'appdb', '-X', '-qAt', '-c',
                                             'SELECT n FROM marker']).stdout)
                        for setup, cleanup in (
                            ('CREATE ROLE extra_role', 'DROP ROLE extra_role'),
                            ('GRANT pg_read_all_data TO app', 'REVOKE pg_read_all_data FROM app'),
                        ):
                            with self.subTest(unsupported_scope=setup):
                                process(['psql', *conn, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', setup])
                                before = scope_state()
                                self.assertEqual(before[3], b'99\n')
                                commands = []
                                def tracking_runner(args, **kwargs):
                                    commands.append((args[args.index('exec') + 5:], kwargs.get('input', b'')))
                                    return runner(args, **kwargs)
                                with self.assertRaisesRegex(RestoreError, '^unsupported PostgreSQL scope$'):
                                    adapter._restore_disposable_test_only(runner=tracking_runner)
                                self.assertEqual(scope_state(), before)
                                self.assertFalse(any(command[0] == 'pg_restore' and '--create' in command
                                                     or b'ALTER DATABASE' in sql or b'pg_terminate_backend' in sql
                                                     for command, sql in commands))
                                process(['psql', *conn, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', cleanup])
                        process(['psql', *conn, '-d', 'appdb', '-c', 'UPDATE marker SET n=42'])
                        for phase in ('after_disable_connections', 'sessions_remain', 'after_restore', 'after_drop'):
                            with self.subTest(phase=phase):
                                change_properties()
                                failure[0] = phase
                                with self.assertRaises((RestoreError, RuntimeError)):
                                    adapter._restore_disposable_test_only(runner=runner)
                                adapter._restore_disposable_test_only(runner=runner, selected_database_properties=properties)
                                result = process(['psql', *conn, '-d', 'appdb', '-qAt', '-c', 'SELECT n FROM marker'])
                                self.assertEqual(result.stdout, b'42\n')
                                assert_restored()
                        mismatches = {key: {**properties, key: changed[key]}
                                      for key in ('comment', 'connection_limit', 'acl')}
                        for role in ('', 'app'):
                            mismatch = json.loads(json.dumps(properties))
                            target = next(s for s in mismatch['settings'] if s['role'] == role)
                            target['config'] = next(s['config'] for s in changed['settings'] if s['role'] == role)
                            mismatches['settings:' + (role or 'database')] = mismatch
                        for key, mismatch in mismatches.items():
                            with self.subTest(mismatched_property=key):
                                change_properties()
                                with self.assertRaisesRegex(RestoreError, '^database properties mismatch$'):
                                    adapter._restore_disposable_test_only(runner=runner,
                                        selected_database_properties=mismatch)
                                assert_restored()
                                change_properties()
                                adapter._restore_disposable_test_only(runner=runner, selected_database_properties=properties)
                                assert_restored()
                        process(['psql', *conn, '-d', 'postgres', '-c',
                                 "ALTER ROLE app PASSWORD 'old-secret'; ALTER ROLE app SET timezone TO 'UTC'; ALTER ROLE app CONNECTION LIMIT 8"])
                        password = process(['psql', *conn, '-d', 'postgres', '-qAt', '-c',
                                            "SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname='app'"]).stdout.decode().strip()
                        record = dict(rolinherit=True, rolcreatedb=False, rolcreaterole=False,
                                      rolcanlogin=True, rolreplication=False, rolbypassrls=False,
                                      rolconnlimit=8, rolvaliduntil=None, rolpassword=password,
                                      settings={'timezone': 'UTC'})
                        def authenticate(password_value):
                            hba = data / 'pg_hba.conf'
                            original = hba.read_text()
                            try:
                                hba.write_text('local all all scram-sha-256\n' + original)
                                process(['pg_ctl', '-D', str(data), 'reload'])
                                return subprocess.run(['psql', *conn, '-d', 'postgres', '-c', 'SELECT 1'],
                                                      env=dict(env, PGPASSWORD=password_value), stdout=subprocess.PIPE,
                                                      stderr=subprocess.PIPE, timeout=30).returncode == 0
                            finally:
                                hba.write_text(original)
                                process(['pg_ctl', '-D', str(data), 'reload'])
                        for phase in ('inside_role', 'after_role_restore', 'after_verify_role'):
                            with self.subTest(role_failure=phase):
                                process(['psql', *conn, '-d', 'postgres', '-c',
                                         "ALTER ROLE app PASSWORD 'new-secret'; ALTER ROLE app SET timezone TO 'Europe/Paris'; ALTER ROLE app CONNECTION LIMIT 3"])
                                failure[0] = phase
                                with self.assertRaises((RestoreError, RuntimeError)):
                                    adapter._restore_disposable_test_only(runner=runner, role_record=record)
                                if phase == 'inside_role':
                                    self.assertTrue(authenticate('new-secret'))
                                adapter._restore_disposable_test_only(runner=runner, role_record=record,
                                    selected_database_properties=properties)
                                self.assertTrue(authenticate('old-secret'))
                                self.assertFalse(authenticate('new-secret'))
                                state = process(['psql', *conn, '-d', 'postgres', '-qAt', '-c',
                                    "SELECT rolconnlimit, (SELECT setconfig::text FROM pg_catalog.pg_db_role_setting WHERE setrole=a.oid AND setdatabase=0) FROM pg_catalog.pg_authid a WHERE rolname='app'"]).stdout
                                self.assertEqual(state, b'8|{TimeZone=UTC}\n')
                        process(['psql', *conn, '-d', 'postgres', '-c', "ALTER ROLE app VALID UNTIL '2030-01-01'"])
                        with self.assertRaises(RestoreError):
                            adapter._restore_disposable_test_only(runner=runner, role_record=record)
                        allowed = process(['psql', *conn, '-d', 'postgres', '-qAt', '-c',
                                           "SELECT datallowconn FROM pg_database WHERE datname='appdb'"])
                        self.assertEqual(allowed.stdout, b't\n')
                        with self.assertRaises(RestoreError):
                            adapter.restore()
                finally:
                    os.close(fd)
            finally:
                if running:
                    process(['pg_ctl', '-D', str(data), '-m', 'fast', '-w', 'stop'])


if __name__ == '__main__':
    unittest.main()
