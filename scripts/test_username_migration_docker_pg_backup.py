"""Offline tests for unverified Docker PostgreSQL capture. No Docker is run."""
import json
import os
import stat
import subprocess
from pathlib import Path
import tempfile
import unittest

import isolated_pg_supervisor as supervisor
import username_migration_docker_pg_restore_check as restore_check
from types import SimpleNamespace

from username_migration_docker_pg_backup import CaptureError, UnverifiedDockerCapture


CONTAINER = 'a' * 64
SOURCE = 'b' * 64
IMAGE = 'c' * 64
OPERATION = 'synthetic-operation-123'
PASSWORD = 'md5' + 'a' * 32


def row(cid, running):
    return {'Id': cid, 'State': {'Running': running, 'Paused': False, 'Restarting': False},
            'Image': 'sha256:' + IMAGE, 'Config': {'Labels': {'username-migration.operation': OPERATION}},
            'HostConfig': {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}}, 'NetworkSettings': {'Networks': {}},
            'Mounts': [{'Type': 'volume', 'Name': 'synthetic-volume',
                        'Destination': '/data', 'RW': True}]}


class FakeDocker:
    def __init__(self):
        self.rows = [row(CONTAINER, True), row(SOURCE, False)]
        self.volume = {'Name': 'synthetic-volume', 'Driver': 'local',
                       'Options': {}, 'Mountpoint': '/synthetic'}
        self.calls = []
        self.execs = 0
        self.fail_dump = False
        self.raise_with_password = False

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        command = args[3:]
        if self.raise_with_password:
            raise RuntimeError(PASSWORD)
        if command[:2] == ['volume', 'inspect']:
            data = json.dumps([self.volume]).encode()
        elif command[:2] == ['container', 'ls']:
            data = ('\n'.join(r['Id'] for r in self.rows) + '\n').encode()
        elif command[:2] == ['container', 'inspect']:
            data = json.dumps(self.rows).encode()
        elif command[0] == 'exec':
            self.execs += 1
            if 'psql' in command:
                data = json.dumps({'system_id': '12345',
                    'role': {'rolname': 'app', 'rolpassword': PASSWORD, 'rolsuper': True,
                             'rolinherit': True, 'rolcreatedb': True, 'rolcreaterole': True,
                             'rolcanlogin': True, 'rolreplication': False, 'rolbypassrls': False,
                             'rolconnlimit': -1, 'rolvaliduntil': None, 'settings': {}},
                    'database': {'datname': 'chat', 'owner': 'app'},
                    'selected_database_properties': {'name': 'chat', 'owner': 'app',
                        'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C',
                        'connection_limit': -1, 'comment': None, 'acl': [], 'settings': []},
                    'roles': ['app'], 'databases': ['chat'], 'prepared': 0, 'memberships': 0}).encode()
            elif 'pg_dump' in command:
                os.write(kwargs['stdout'], b'PGDMP synthetic archive')
                return SimpleNamespace(returncode=int(self.fail_dump), stdout=None)
            else:
                raise AssertionError('unexpected exec')
        else:
            raise AssertionError('unexpected command')
        return SimpleNamespace(returncode=0, stdout=data)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.fd = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.fake = FakeDocker()
        self.gate = lambda: True

    def tearDown(self):
        os.close(self.fd)
        self.tmp.cleanup()

    def capture(self, **changes):
        options = dict(directory_fd=self.fd, operation=OPERATION, container_id=CONTAINER,
                       image_id=IMAGE, volume='synthetic-volume', volume_destination='/data',
                       stopped_container_ids=[SOURCE], gate=self.gate, runner=self.fake)
        options.update(changes)
        return UnverifiedDockerCapture(**options).capture(database='chat', role='app')

    def file(self, name):
        return os.path.join(self.tmp.name, name)

    def test_capture_sql_against_disposable_postgres(self):
        pgroot = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))
        params = dict(bindir=str(pgroot / 'bin'), share=str(pgroot / 'share/pgsql'),
                      library_path=str(pgroot / 'lib64'), parent=self.tmp.name, superuser='app')
        with supervisor.IsolatedPostgres(**params) as source:
            source.run('createdb', ['chat'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            source.run('psql', ['-X', '-q', '-d', 'chat', '-c',
                       'CREATE TABLE test_data (value integer); INSERT INTO test_data VALUES (42);'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            fake = self.fake
            def runner(args, **kwargs):
                command = args[3:]
                if command and command[0] == 'exec':
                    for program in ('psql', 'pg_dump'):
                        if program in command:
                            index = command.index(program)
                            return source.run(program, command[index + 1:],
                                              input=kwargs.get('input'), stdout=kwargs.get('stdout'),
                                              stderr=subprocess.DEVNULL)
                return fake(args, **kwargs)
            self.capture(runner=runner)
            metadata = json.loads((Path(self.tmp.name) / 'postgres-metadata.json').read_text())
            properties = metadata['selected_database_properties']
            self.assertEqual((properties['name'], properties['owner']), ('chat', 'app'))
            self.assertTrue(any(entry['grantee'] == 'PUBLIC' for entry in properties['acl']))
            self.assertEqual(properties['settings'], [])
            self.assertEqual(metadata['role']['rolname'], 'app')
            dump = (Path(self.tmp.name) / 'postgres.dump').read_bytes()
            self.assertTrue(dump.startswith(b'PGDMP'))
            import hashlib
            with supervisor.IsolatedPostgres(**params) as target:
                def validation_runner(args, **kwargs):
                    command = args[3:]
                    for program in ('psql', 'pg_restore'):
                        if program in command:
                            index = command.index(program)
                            options = {'stdout': kwargs.get('stdout'), 'stderr': subprocess.DEVNULL}
                            if kwargs.get('stdin') is not None:
                                options['stdin'] = kwargs['stdin']
                            if kwargs.get('input') is not None:
                                options['input'] = kwargs['input']
                            return target.run(program, command[index + 1:], **options)
                    raise AssertionError('unexpected validation command')
                check = restore_check.DisposableRestoreCheck(
                    directory_fd=self.fd, expected_sha256=hashlib.sha256(dump).hexdigest(),
                    selected_database_properties=properties,
                    expected_source_system_identifier=metadata['system_id'], container_id=CONTAINER,
                    gate=lambda: True, runner=validation_runner)
                evidence = check.check()
                self.assertEqual(evidence['status'], 'MATCHED')
                self.assertEqual(evidence['source_system_identifier'], metadata['system_id'])
                self.assertNotEqual(evidence['target_system_identifier'], metadata['system_id'])
                count = target.run('psql', ['-X', '-qAt', '-d', 'chat', '-c',
                                    'SELECT value FROM test_data;'], stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL)
                self.assertEqual(count.stdout.strip(), b'42')

    def test_capture_private_permissions_and_no_password_in_arguments(self):
        result = self.capture()
        self.assertEqual(result['status'], 'UNVERIFIED')
        self.assertFalse(result['restore_authorized'])
        with open(self.file('postgres.dump'), 'rb') as f:
            self.assertEqual(f.read(), b'PGDMP synthetic archive')
        with open(self.file('postgres-metadata.json'), 'rb') as f:
            self.assertEqual(json.load(f)['role']['rolpassword'], PASSWORD)
        for name in ('postgres.dump', 'postgres-metadata.json'):
            self.assertEqual(stat.S_IMODE(os.stat(self.file(name)).st_mode), 0o600)
        self.assertEqual(self.fake.execs, 2)
        for args, _ in self.fake.calls:
            self.assertNotIn(PASSWORD, ' '.join(args))
        sql_call = next(kwargs for args, kwargs in self.fake.calls if 'psql' in args)
        self.assertIn(b'pg_authid', sql_call['input'])

    def test_database_properties_reject_incomplete_or_malformed_metadata(self):
        from username_migration_docker_pg_backup import _validate_database_properties
        valid = {'name': 'chat', 'owner': 'app', 'encoding': 'UTF8',
                 'collate': 'C', 'ctype': 'C', 'connection_limit': -1,
                 'comment': None, 'acl': [{'grantor': 'app', 'grantee': 'PUBLIC',
                 'privilege': 'CONNECT', 'grantable': False}],
                 'settings': [{'role': '', 'config': ['work_mem=4MB']}]}
        _validate_database_properties(valid, 'chat', 'app')
        for key in valid:
            with self.subTest(missing=key):
                malformed = dict(valid)
                del malformed[key]
                with self.assertRaises(ValueError):
                    _validate_database_properties(malformed, 'chat', 'app')
        for key, value in [('owner', 'other'), ('connection_limit', True),
                           ('acl', [{'grantable': False}]),
                           ('settings', [{'role': '', 'config': [1]}])]:
            with self.subTest(key=key):
                malformed = dict(valid, **{key: value})
                with self.assertRaises(ValueError):
                    _validate_database_properties(malformed, 'chat', 'app')

    def test_no_overwrite_and_retry_requires_new_directory(self):
        self.capture()
        with open(self.file('postgres.dump'), 'rb') as f:
            before = f.read()
        calls = len(self.fake.calls)
        with self.assertRaises(FileExistsError):
            self.capture()
        self.assertEqual(len(self.fake.calls), calls)
        with open(self.file('postgres.dump'), 'rb') as f:
            self.assertEqual(f.read(), before)

    def test_existing_metadata_is_not_overwritten(self):
        with open(self.file('postgres-metadata.json'), 'wb') as f:
            f.write(b'existing')
        with self.assertRaises(FileExistsError):
            self.capture()
        with open(self.file('postgres-metadata.json'), 'rb') as f:
            self.assertEqual(f.read(), b'existing')
        self.assertTrue(os.path.exists(self.file('postgres.dump')))
        self.assertEqual(self.fake.execs, 1)

    def test_topology_mismatch_fails_before_exec(self):
        cases = ('network_mode', 'network_attachment', 'image', 'volume', 'destination',
                 'label', 'source_active', 'source_restart', 'maintenance_restart', 'source_missing', 'volume_driver')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                os.chmod(directory, 0o700)
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                fake = FakeDocker()
                main, source = fake.rows
                if case == 'network_mode': main['HostConfig']['NetworkMode'] = 'bridge'
                if case == 'network_attachment': main['NetworkSettings']['Networks'] = {'bridge': {}}
                if case == 'image': main['Image'] = 'sha256:' + 'd' * 64
                if case == 'volume': main['Mounts'][0]['Name'] = 'wrong'
                if case == 'destination': main['Mounts'][0]['Destination'] = '/wrong'
                if case == 'label': main['Config']['Labels']['username-migration.operation'] = 'wrong'
                if case == 'source_active': source['State']['Running'] = True
                if case == 'source_restart': source['HostConfig']['RestartPolicy']['Name'] = 'always'
                if case == 'maintenance_restart': main['HostConfig']['RestartPolicy']['Name'] = 'always'
                if case == 'source_missing': fake.rows.pop()
                if case == 'volume_driver': fake.volume['Driver'] = 'remote'
                try:
                    with self.assertRaisesRegex(CaptureError, 'topology'):
                        self.capture(directory_fd=fd, runner=fake)
                    self.assertEqual(fake.execs, 0)
                finally:
                    os.close(fd)

    def test_gate_breach_before_and_after_each_exec(self):
        # Each verification checks the gate twice. Fail at each boundary around
        # both psql and pg_dump, including after a successful command.
        for breach in range(1, 9):
            with self.subTest(breach=breach), tempfile.TemporaryDirectory() as directory:
                os.chmod(directory, 0o700)
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                fake = FakeDocker()
                count = [0]
                def gate():
                    count[0] += 1
                    return count[0] != breach
                try:
                    with self.assertRaisesRegex(CaptureError, 'topology'):
                        self.capture(directory_fd=fd, runner=fake, gate=gate)
                    self.assertEqual(fake.execs, (breach - 1) // 4 + (1 if (breach - 1) % 4 >= 2 else 0))
                finally:
                    os.close(fd)

    def test_failed_dump_preserves_private_partial_evidence_and_closes_fd(self):
        self.fake.fail_dump = True
        with self.assertRaisesRegex(CaptureError, 'Docker command failed'):
            self.capture()
        dump_fd = next(kwargs['stdout'] for args, kwargs in self.fake.calls if 'pg_dump' in args)
        with self.assertRaises(OSError):
            os.fstat(dump_fd)
        self.assertGreater(os.stat(self.file('postgres.dump')).st_size, 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.file('postgres.dump')).st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            self.capture()

    def test_runner_exception_is_sanitized(self):
        self.fake.raise_with_password = True
        with self.assertRaises(CaptureError) as caught:
            self.capture()
        self.assertNotIn(PASSWORD, str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__)

    def test_rejects_unsafe_directory_and_source_configuration(self):
        os.chmod(self.tmp.name, 0o755)
        with self.assertRaisesRegex(CaptureError, 'unsafe evidence directory'):
            self.capture()
        os.chmod(self.tmp.name, 0o700)
        for sources in ([CONTAINER], ['short-id'], ['d' * 64]):
            with self.subTest(sources=sources), self.assertRaises(CaptureError):
                self.capture(stopped_container_ids=sources)
        self.assertEqual(self.fake.execs, 0)


if __name__ == '__main__':
    unittest.main()
