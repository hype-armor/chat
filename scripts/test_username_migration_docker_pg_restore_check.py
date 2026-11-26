"""Fake-runner tests only. No Docker daemon or live data is used."""
import hashlib
import json
import os
import stat
import tempfile
import unittest
from types import SimpleNamespace

from username_migration_docker_pg_restore_check import DisposableRestoreCheck, RestoreCheckError

ARCHIVE = b'PGDMP synthetic archive'
CONTAINER = 'a' * 64
PROPERTIES = {'name': 'chat', 'owner': 'app', 'encoding': 'UTF8', 'collate': 'C',
              'ctype': 'C', 'connection_limit': -1, 'comment': None,
              'acl': [{'grantor': 'app', 'grantee': 'PUBLIC', 'privilege': 'CONNECT', 'grantable': False}],
              'settings': [{'role': '', 'config': ['work_mem=4MB']}]}


class FakeDocker:
    def __init__(self):
        self.calls = []
        self.listing = b';\n;     dbname: chat\n;\n'
        self.properties = json.loads(json.dumps(PROPERTIES))
        self.fail = None
        self.mutate = None
        self.system_id = b'456\n'

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        n = len(self.calls)
        if self.mutate:
            self.mutate(n)
        if n == self.fail:
            raise ValueError('secret diagnostic')
        if kwargs.get('input') == b'SELECT system_identifier::text FROM pg_control_system();\n':
            output = self.system_id
        elif 'pg_restore' in args:
            content = b''
            while True:
                part = os.read(kwargs['stdin'], 1024)
                if not part:
                    break
                content += part
            if content != ARCHIVE:
                raise AssertionError('incorrect staged bytes')
            output = self.listing if '--list' in args else None
        else:
            output = json.dumps(self.properties).encode()
        return SimpleNamespace(returncode=0, stdout=output)


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/srv/chat')
        os.chmod(self.tmp.name, 0o700)
        self.fd = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.path = os.path.join(self.tmp.name, 'postgres.dump')
        with open(self.path, 'wb') as f:
            f.write(ARCHIVE)
        os.chmod(self.path, 0o600)
        self.fake = FakeDocker()
        self.gate = lambda: True

    def tearDown(self):
        os.close(self.fd)
        self.tmp.cleanup()

    def check(self, **changes):
        options = dict(directory_fd=self.fd, expected_sha256=hashlib.sha256(ARCHIVE).hexdigest(),
                       selected_database_properties=PROPERTIES, expected_source_system_identifier='123', container_id=CONTAINER,
                       gate=self.gate, runner=self.fake)
        options.update(changes)
        return DisposableRestoreCheck(**options).check()

    def evidence_exists(self):
        return os.path.exists(os.path.join(self.tmp.name, 'postgres-restore-check.json'))

    def test_success_and_private_durable_record(self):
        result = self.check()
        self.assertFalse(result['restore_authorized'])
        self.assertFalse(result['operational'])
        path = os.path.join(self.tmp.name, 'postgres-restore-check.json')
        with open(path, 'rb') as f:
            self.assertEqual(json.load(f), result)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(result['container_id'], CONTAINER)
        self.assertEqual(result['archive_sha256'], hashlib.sha256(ARCHIVE).hexdigest())
        self.assertEqual(result['selected_database_properties'], PROPERTIES)
        self.assertEqual(result['source_system_identifier'], '123')
        self.assertEqual(result['target_system_identifier'], '456')
        commands = [args for args, kwargs in self.fake.calls if kwargs.get('input') !=
                    b'SELECT system_identifier::text FROM pg_control_system();\n']
        self.assertEqual(len(commands), 3)
        self.assertIn('--list', commands[0])
        self.assertIn('--create', commands[1])
        self.assertIn('--exit-on-error', commands[1])
        self.assertEqual(commands[1][-1], 'postgres')
        self.assertIn('psql', commands[2])
        self.assertTrue(any(b'aclexplode' in kwargs.get('input', b'') for _, kwargs in self.fake.calls))
        with self.assertRaises(RestoreCheckError):
            self.check()

    def test_archive_digest_and_listing_rejected(self):
        with self.assertRaises(RestoreCheckError):
            self.check(expected_sha256='b' * 64)
        self.assertEqual(len(self.fake.calls), 0)
        for listing in (b';     dbname: wrong\n', b'', b';     dbname: chat\n;     dbname: chat\n'):
            self.fake = FakeDocker()
            self.fake.listing = listing
            with self.assertRaises(RestoreCheckError):
                self.check()
            self.assertEqual(len(self.fake.calls), 3)
            self.assertFalse(self.evidence_exists())

    def test_archive_mutation_after_staging_does_not_change_input(self):
        def mutate(n):
            if n == 2:
                with open(self.path, 'wb') as f:
                    f.write(b'changed')
        self.fake.mutate = mutate
        self.check()
        self.assertTrue(self.evidence_exists())

    def test_gate_failure_at_each_boundary(self):
        for breach in range(1, 23):
            with self.subTest(breach=breach):
                self.fake = FakeDocker()
                count = [0]
                def gate():
                    count[0] += 1
                    return count[0] != breach
                self.gate = gate
                with self.assertRaises(RestoreCheckError):
                    self.check()
                self.assertFalse(self.evidence_exists())

    def test_command_failure_and_property_mismatch(self):
        for n in range(1, 11):
            self.fake = FakeDocker()
            self.fake.fail = n
            with self.assertRaises(RestoreCheckError) as e:
                self.check()
            self.assertNotIn('secret', str(e.exception))
            self.assertFalse(self.evidence_exists())
        self.fake = FakeDocker()
        self.fake.properties['acl'][0]['grantable'] = True
        with self.assertRaises(RestoreCheckError):
            self.check()
        self.assertFalse(self.evidence_exists())

    def test_system_identifier_rejected_and_changes_fail_closed(self):
        for source in ('0', '01', '', '18446744073709551616', 123, None):
            with self.subTest(source=source), self.assertRaises(RestoreCheckError):
                self.check(expected_source_system_identifier=source)
        self.assertEqual(self.fake.calls, [])
        for target in (b'123\n', b'0\n', b'01\n', b'18446744073709551616\n',
                       b'456', b'456\nextra\n', b'\xff\n'):
            self.fake = FakeDocker()
            self.fake.system_id = target
            with self.subTest(target=target), self.assertRaises(RestoreCheckError):
                self.check()
            self.assertEqual(len(self.fake.calls), 1)
            self.assertFalse(self.evidence_exists())
        for change_at in (3, 4, 6, 7, 9, 10):
            self.fake = FakeDocker()
            self.fake.mutate = lambda n: setattr(self.fake, 'system_id', b'789\n') if n == change_at else None
            with self.subTest(change_at=change_at), self.assertRaises(RestoreCheckError):
                self.check()
            self.assertFalse(self.evidence_exists())

    def test_unsafe_input_fails_closed(self):
        os.chmod(self.path, 0o644)
        with self.assertRaises(RestoreCheckError):
            self.check()
        os.chmod(self.path, 0o600)
        with self.assertRaises(RestoreCheckError):
            self.check(selected_database_properties=dict(PROPERTIES, name='postgres'))
        os.chmod(self.tmp.name, 0o755)
        with self.assertRaises(RestoreCheckError):
            self.check()
        self.assertEqual(len(self.fake.calls), 0)


if __name__ == '__main__':
    unittest.main()
