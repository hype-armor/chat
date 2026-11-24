#!/usr/bin/env python3
"""Synthetic PostgreSQL restore test. Does not access live services."""
import hashlib
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('scoped_restore', HERE / 'username_migration_scoped_restore.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))
BIN = ROOT / 'bin'
ENV = {**os.environ, 'LD_LIBRARY_PATH': str(ROOT / 'lib64'), 'PGCONNECT_TIMEOUT': '2'}
ENV.pop('PGPASSWORD', None)


def run(program, *args, input=None, password=None, check=True):
    env = dict(ENV)
    if password is not None:
        env['PGPASSWORD'] = password
    return subprocess.run([str(BIN / program), *args], input=input, text=True, env=env,
                          capture_output=True, check=check, timeout=45)


class ScopedRestoreTest(unittest.TestCase):
    def test_restore_and_reject_wrong_manifest(self):
        with tempfile.TemporaryDirectory(prefix='scoped-restore-test-') as temp:
            root = Path(temp)
            data, sock, backups = root / 'data', root / 'socket', root / 'backup'
            sock.mkdir(mode=0o700); backups.mkdir(mode=0o700)
            with socket.socket() as s:
                s.bind(('127.0.0.1', 0))
                port = s.getsockname()[1]
            run('initdb', '-L', str(ROOT / 'share/pgsql'), '-D', str(data), '-U', 'chat', '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale')
            run('pg_ctl', '-D', str(data), '-l', str(root / 'log'), '-o', f"-k {sock} -p {port} -c listen_addresses=127.0.0.1", '-w', 'start')
            def sql(query, database='postgres'):
                return run('psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', str(port), '-U', 'chat', '-d', database, input=query).stdout.strip()
            def tcp(password):
                return run('psql', '-X', '-qAt', '-h', '127.0.0.1', '-p', str(port), '-U', 'chat', '-d', 'appdb', input='SELECT count(*) FROM sample;', password=password, check=False)
            try:
                sql("ALTER ROLE chat PASSWORD 'oldsynthetic';")
                env = module._environment(str(BIN), str(sock), port, 'chat', str(ROOT / 'lib64'))
                null_expiry = module._role_state(str(BIN), env, 'chat')
                self.assertIsNone(null_expiry['rolvaliduntil'])
                module._restore_role(str(BIN), env, 'chat', null_expiry)
                self.assertEqual(module._role_state(str(BIN), env, 'chat'), null_expiry)
                sql("ALTER ROLE chat NOINHERIT CREATEDB CREATEROLE REPLICATION BYPASSRLS CONNECTION LIMIT 13 VALID UNTIL 'infinity';")
                sql("ALTER ROLE chat SET search_path TO public, pg_catalog;")
                sql("ALTER ROLE chat SET timezone TO 'Europe/Paris';")
                env = module._environment(str(BIN), str(sock), port, 'chat', str(ROOT / 'lib64'))
                role_record = module._role_state(str(BIN), env, 'chat')
                sysid = sql('SELECT system_identifier FROM pg_control_system();')
                sql('CREATE DATABASE appdb OWNER chat;')
                sql("CREATE TABLE sample (id integer); INSERT INTO sample VALUES (42); REVOKE ALL ON sample FROM PUBLIC;", 'appdb')
                sql("ALTER DATABASE appdb SET timezone TO 'UTC';")
                acl_query = "SELECT coalesce(string_agg(grantee::text || ':' || privilege_type || ':' || is_grantable::text, ',' ORDER BY grantee, privilege_type),'') FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) WHERE c.oid='sample'::regclass;"
                original_acl = sql(acl_query, 'appdb')
                dump = backups / 'snapshot'
                run('pg_dump', '-h', str(sock), '-p', str(port), '-U', 'chat', '-Fc', '--create', '-f', str(dump), 'appdb')
                dump.chmod(0o600)
                archive_bytes = dump.read_bytes()
                digest = hashlib.sha256(archive_bytes).hexdigest()
                sql('ALTER TABLE sample ADD COLUMN migrated boolean; INSERT INTO sample VALUES (43, true);', 'appdb')
                sql("ALTER ROLE chat PASSWORD 'newsynthetic' INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;")
                sql("ALTER ROLE chat RESET ALL;")
                args = dict(bindir=str(BIN), socket=str(sock), port=port, role='chat', database='appdb', directory=str(backups), archive='snapshot', expected_system_id=sysid, expected_sha256=digest, validated_archive_sha256=digest, role_record=role_record, library_path=str(ROOT / 'lib64'))
                with self.assertRaises(module.RestoreError):
                    module._restore_disposable_test_only(**{**args, 'expected_system_id': '1'})
                self.assertEqual(sql('SELECT count(*) FROM sample;', 'appdb'), '2')
                with self.assertRaises(module.RestoreError):
                    module._restore_disposable_test_only(**{**args, 'expected_sha256': '0' * 64, 'validated_archive_sha256': '0' * 64})
                with self.assertRaises(module.RestoreError):
                    module.restore_verified(**args)
                for invalid in ({**role_record, 'rolcanlogin': False},
                                {**role_record, 'rolvaliduntil': None},
                                {**role_record, 'rolsuper': False},
                                {**role_record, 'settings': {'standard_conforming_strings': 'off'}},
                                {**role_record, 'settings': {'role': 'other'}},
                                {**role_record, 'settings': {'search_path;DROP ROLE chat': 'public'}}):
                    with self.assertRaises(module.RestoreError):
                        module._restore_disposable_test_only(**{**args, 'role_record': invalid})
                with mock.patch.object(module.os, 'fsync', side_effect=OSError('simulated disk failure')):
                    with self.assertRaises(OSError):
                        module._restore_disposable_test_only(**args)
                self.assertEqual(sql('SELECT count(*) FROM sample;', 'appdb'), '2')
                real_command = module._command
                def fail_after_connections_disabled(*command_args, **command_kwargs):
                    if command_args[1] == 'pg_restore' and '--create' in command_args[2]:
                        raise module.RestoreError('injected restore failure')
                    return real_command(*command_args, **command_kwargs)
                with mock.patch.object(module, '_command', side_effect=fail_after_connections_disabled):
                    with self.assertRaises(module.RestoreError):
                        module._restore_disposable_test_only(**args)
                self.assertEqual(sql("SELECT datallowconn FROM pg_database WHERE datname='appdb';"), 'f')
                # Retry must succeed even after the previous attempt disabled connections.
                def mutate_original_after_listing(*command_args, **command_kwargs):
                    result = real_command(*command_args, **command_kwargs)
                    if command_args[1] == 'pg_restore' and '--list' in command_args[2]:
                        dump.write_bytes(b'changed after verification')
                    return result
                with mock.patch.object(module, '_command', side_effect=mutate_original_after_listing):
                    module._restore_disposable_test_only(**args)
                self.assertEqual(dump.read_bytes(), b'changed after verification')
                dump.write_bytes(archive_bytes)
                self.assertEqual(sql('SELECT count(*), min(id) FROM sample;', 'appdb'), '1|42')
                self.assertEqual(sql("SELECT count(*) FROM information_schema.columns WHERE table_name='sample' AND column_name='migrated';", 'appdb'), '0')
                self.assertEqual(sql(acl_query, 'appdb'), original_acl)
                self.assertEqual(sql("SELECT setconfig FROM pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname='appdb') AND setrole=0;"), '{TimeZone=UTC}')
                self.assertEqual(tcp('oldsynthetic').returncode, 0)
                self.assertNotEqual(tcp('newsynthetic').returncode, 0)
                self.assertEqual(module._role_state(str(BIN), env, 'chat'), role_record)
                malicious = "public\\'; DROP TABLE sample; --"
                encoded = module._encoded_sql_text(malicious)
                self.assertNotIn(malicious, encoded)
                with self.assertRaises(module.RestoreError):
                    module._restore_role(str(BIN), env, 'chat',
                        {**role_record, 'settings': {'search_path': malicious}})
                self.assertEqual(sql('SELECT count(*) FROM sample;', 'appdb'), '1')
                self.assertEqual(module._role_state(str(BIN), env, 'chat'), role_record)
                # A failure after role changes must leave a retryable state.
                sql("ALTER ROLE chat INHERIT NOCREATEDB; ALTER ROLE chat RESET ALL;")
                before_partial = module._role_state(str(BIN), env, 'chat')
                real_sql = module._sql
                def fail_inside_role_transaction(bindir, call_env, statement, *rest):
                    if 'ALTER ROLE "chat" RESET ALL' in statement:
                        statement = statement.replace('ALTER ROLE "chat" RESET ALL',
                                                      'SELECT 1/0; ALTER ROLE "chat" RESET ALL')
                    return real_sql(bindir, call_env, statement, *rest)
                with mock.patch.object(module, '_sql', side_effect=fail_inside_role_transaction):
                    with self.assertRaises(module.RestoreError):
                        module._restore_disposable_test_only(**args)
                self.assertEqual(module._role_state(str(BIN), env, 'chat'), before_partial)
                real_restore_role = module._restore_role
                def fail_after_role_change(*call_args):
                    real_restore_role(*call_args)
                    raise module.RestoreError('injected role-state failure')
                with mock.patch.object(module, '_restore_role', side_effect=fail_after_role_change):
                    with self.assertRaises(module.RestoreError):
                        module._restore_disposable_test_only(**args)
                self.assertEqual(module._role_state(str(BIN), env, 'chat'), role_record)
                module._restore_disposable_test_only(**args)
                self.assertEqual(module._role_state(str(BIN), env, 'chat'), role_record)
                # Simulate failure after database replacement but before the
                # saved credential is restored, then retry under the fence.
                sql('INSERT INTO sample VALUES (99);', 'appdb')
                sql("ALTER ROLE chat PASSWORD 'newsynthetic';")
                def fail_after_database_restore(*command_args, **command_kwargs):
                    result = real_command(*command_args, **command_kwargs)
                    if command_args[1] == 'pg_restore' and '--create' in command_args[2]:
                        raise module.RestoreError('injected post-restore failure')
                    return result
                with mock.patch.object(module, '_command', side_effect=fail_after_database_restore):
                    with self.assertRaises(module.RestoreError):
                        module._restore_disposable_test_only(**args)
                self.assertEqual(sql('SELECT count(*) FROM sample;', 'appdb'), '1')
                self.assertEqual(tcp('newsynthetic').returncode, 0)
                module._restore_disposable_test_only(**args)
                self.assertEqual(sql('SELECT count(*) FROM sample;', 'appdb'), '1')
                self.assertEqual(tcp('oldsynthetic').returncode, 0)
                self.assertNotEqual(tcp('newsynthetic').returncode, 0)
                # A crash after the old database is dropped must also be
                # retryable. This mimics a destructive pg_restore boundary.
                def fail_after_drop(*command_args, **command_kwargs):
                    if command_args[1] == 'pg_restore' and '--create' in command_args[2]:
                        sql('DROP DATABASE appdb;')
                        raise module.RestoreError('injected failure after database drop')
                    return real_command(*command_args, **command_kwargs)
                with mock.patch.object(module, '_command', side_effect=fail_after_drop):
                    with self.assertRaises(module.RestoreError):
                        module._restore_disposable_test_only(**args)
                self.assertEqual(sql("SELECT count(*) FROM pg_database WHERE datname='appdb';"), '0')
                module._restore_disposable_test_only(**args)
                self.assertEqual(sql('SELECT count(*) FROM sample;', 'appdb'), '1')
                self.assertEqual(tcp('oldsynthetic').returncode, 0)
            finally:
                run('pg_ctl', '-D', str(data), '-m', 'fast', '-w', 'stop')


if __name__ == '__main__':
    unittest.main()
