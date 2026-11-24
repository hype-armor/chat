import json
import os
import tempfile
import unittest
from types import SimpleNamespace

from username_migration_docker_validation_lifecycle import DockerValidationLifecycle, LifecycleError


class Daemon:
    def __init__(self):
        self.volume = None
        self.container = None
        self.calls = []
        self.fail_after_create = False

    def __call__(self, argv, **kwargs):
        a = argv[3:]
        self.calls.append(a)
        output = b''
        code = 0
        if a == ['volume', 'ls', '--quiet']:
            output = ((self.volume['Name'] + '\n') if self.volume else '').encode()
        elif a[:2] == ['volume', 'inspect']:
            output = json.dumps([self.volume]).encode()
        elif a[:2] == ['volume', 'create']:
            self.volume = {'Name': a[-1], 'Driver': 'local', 'Options': None,
                           'Labels': {'username-migration.operation': a[-2].split('=', 1)[1]},
                           'Mountpoint': '/var/lib/docker/volumes/test/_data', 'CreatedAt': 'fixed'}
            code = int(self.fail_after_create)
        elif a[:2] == ['container', 'ls']:
            output = (self.container['Id'] if self.container else '').encode()
        elif a[:2] == ['container', 'inspect']:
            output = json.dumps([self.container]).encode()
        elif a[:2] == ['container', 'create']:
            def arg(option):
                return a[a.index(option) + 1]
            labels = [a[i + 1].split('=', 1) for i, x in enumerate(a) if x == '--label']
            env = [a[i + 1] for i, x in enumerate(a) if x == '--env']
            self.container = {'Id': 'b' * 64, 'Name': '/' + arg('--name'), 'Image': a[-1],
                              'Config': {'Labels': dict(labels), 'Env': env},
                              'State': {'Running': False, 'Paused': False, 'Restarting': False},
                              'HostConfig': {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}},
                              'NetworkSettings': {'Networks': {}},
                              'Mounts': [{'Type': 'volume', 'Name': self.volume['Name'],
                                          'Destination': '/var/lib/postgresql/data', 'RW': True}]}
            code = int(self.fail_after_create)
        elif a[:2] == ['container', 'start']:
            self.container['State']['Running'] = True
        elif a[:1] != ['exec']:
            raise AssertionError(a)
        return SimpleNamespace(returncode=code, stdout=output)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fd = os.open(self.temp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.lock = os.open('lock', os.O_CREAT | os.O_RDWR, 0o600, dir_fd=self.fd)
        self.daemon = Daemon()
        self.kwargs = dict(directory_fd=self.fd, lock_fd=self.lock, operation='operation_123456789',
                           source_volume='source', validation_volume='disposable', image_id='a' * 64,
                           role='chat', gate=lambda: True, runner=self.daemon)
        self.obj = DockerValidationLifecycle(**self.kwargs)

    def tearDown(self):
        os.close(self.lock)
        os.close(self.fd)
        self.temp.cleanup()

    def test_create_resume_and_lost_response(self):
        self.daemon.fail_after_create = True
        self.assertEqual(self.obj.ensure_ready(), 'b' * 64)
        self.assertEqual(self.obj.ensure_ready(), 'b' * 64)
        self.assertEqual(sum(a[:2] == ['volume', 'create'] for a in self.daemon.calls), 1)
        self.assertEqual(sum(a[:2] == ['container', 'create'] for a in self.daemon.calls), 1)
        self.assertTrue(any(a[0] == 'exec' and 'pg_isready' in a for a in self.daemon.calls))
        self.assertFalse(any('pg_restore' in a for a in self.daemon.calls))
        self.assertFalse(self.obj.restore_authorized)

    def test_identity_drift_and_missing_objects_fail(self):
        self.obj.ensure_ready()
        self.daemon.container['Id'] = 'c' * 64
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()
        self.daemon.container = None
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()

    def test_environment_and_gate_fail_closed(self):
        self.obj.ensure_ready()
        self.daemon.container['Config']['Env'].append('POSTGRES_PASSWORD=secret')
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()
        self.obj.gate = lambda: False
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()

    def test_reject_same_volume_and_changed_intent(self):
        with self.assertRaises(LifecycleError):
            DockerValidationLifecycle(**(self.kwargs | {'validation_volume': 'source'}))
        self.obj.ensure_ready()
        with self.assertRaises(LifecycleError):
            DockerValidationLifecycle(**(self.kwargs | {'role': 'other'})).ensure_ready()

    def test_lock_contention(self):
        import fcntl
        other = os.open('lock', os.O_RDWR, dir_fd=self.fd)
        try:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(LifecycleError):
                self.obj.ensure_ready()
            self.assertEqual(self.daemon.calls, [])
        finally:
            os.close(other)


if __name__ == '__main__':
    unittest.main()
