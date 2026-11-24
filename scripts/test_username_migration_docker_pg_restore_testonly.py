import hashlib
import os
import tempfile
import unittest
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

from username_migration_docker_pg_restore_testonly import RestoreError, TestOnlyPostgresRestore


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.fd = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.data = b'PGDMP synthetic archive'
        self.path = os.path.join(self.tmp.name, 'postgres.dump')
        with open(self.path, 'wb') as f:
            f.write(self.data)
        os.chmod(self.path, 0o600)
        self.events = []
        self.patch = patch('username_migration_docker_pg_restore_testonly._disk_directory')
        self.patch.start()  # The test filesystem may be overlay, which production rejects.

    def tearDown(self):
        self.patch.stop()
        os.close(self.fd)
        self.tmp.cleanup()

    def make(self, **kwargs):
        params = dict(directory_fd=self.fd, source_system_identifier='123',
                      operation='operation_123456', role='app', database='appdb',
                      archive_sha256=hashlib.sha256(self.data).hexdigest(),
                      container_id='a' * 64,
                      verify_rollback_fence=lambda phase, binding: self.events.append((phase, binding)) or True)
        params.update(kwargs)
        return TestOnlyPostgresRestore(**params)

    def test_snapshot_and_binding(self):
        adapter = self.make()
        adapter.check_snapshot()
        self.assertEqual([x[0] for x in self.events], ['before_snapshot', 'after_snapshot'])
        self.assertEqual(self.events[0][1], ('123', 'operation_123456', 'app', 'appdb',
                                             hashlib.sha256(self.data).hexdigest(), 'a' * 64))
        self.assertEqual(os.listdir(self.tmp.name), ['postgres.dump'])
        self.assertFalse(adapter.operational)
        with self.assertRaises(RestoreError):
            adapter.restore()

    def test_digest_and_magic_rejected(self):
        with self.assertRaises(RestoreError):
            self.make(archive_sha256='0' * 64).check_snapshot()
        self.data = b'wrong magic'
        with open(self.path, 'wb') as f:
            f.write(self.data)
        with self.assertRaises(RestoreError):
            self.make().check_snapshot()

    def test_fence_and_unsafe_archive_rejected(self):
        with self.assertRaises(RestoreError):
            self.make(verify_rollback_fence=lambda *_: False).check_snapshot()
        os.chmod(self.path, 0o644)
        with self.assertRaises(RestoreError):
            self.make().check_snapshot()

    def test_preflight_and_failures(self):
        def run_with(identity=b'123\n', listing=b';     dbname: appdb\n', failure=None):
            calls = []
            def runner(args, **kwargs):
                calls.append(args)
                if 'pg_restore' in args:
                    self.assertEqual(os.read(kwargs['stdin'], 5), b'PGDMP')
                    with self.assertRaises(OSError):
                        os.write(kwargs['stdin'], b'x')
                    return SimpleNamespace(returncode=0, stdout=listing)
                return SimpleNamespace(returncode=0, stdout=identity)
            adapter = self.make(verify_rollback_fence=lambda phase, binding: phase != failure)
            return adapter, runner, calls
        adapter, runner, calls = run_with()
        adapter.preflight(runner=runner)
        self.assertEqual(len(calls), 2)
        for identity, listing in [(b'124\n', b';     dbname: appdb\n'),
                                  (b'123\n', b';     dbname: other\n'),
                                  (b'123\n', b';     dbname: appdb\n;     dbname: appdb\n'),
                                  (b'123\n', b'; dbname: appdb\n')]:
            adapter, runner, _ = run_with(identity, listing)
            with self.assertRaises(RestoreError):
                adapter.preflight(runner=runner)
        for phase in ('before_identity', 'after_identity', 'before_list', 'after_list'):
            adapter, runner, _ = run_with(failure=phase)
            with self.assertRaises(RestoreError):
                adapter.preflight(runner=runner)

    def test_invalid_binding_rejected(self):
        for args in ({'source_system_identifier': '0'}, {'database': 'postgres'},
                     {'operation': 'short'}, {'container_id': 'x' * 64}):
            with self.subTest(args=args), self.assertRaises(RestoreError):
                self.make(**args)


if __name__ == '__main__':
    unittest.main()
