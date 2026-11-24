import json
import os
import tempfile
import unittest
from types import SimpleNamespace

from unittest.mock import patch

from username_migration_validation_pg18 import DockerValidationLifecycle, LifecycleError


class Daemon:
    def __init__(self, root):
        self.root = root
        os.mkdir(os.path.join(root, 'source'))
        os.mkdir(os.path.join(root, 'validation'))
        self.source = {'Name': 'source', 'Driver': 'local', 'Options': None,
                       'Mountpoint': os.path.join(root, 'source'), 'CreatedAt': 'source'}
        self.volume = None
        self.container = None
        self.calls = []
        self.fail_after_create = False

    def __call__(self, argv, **kwargs):
        a = argv[3:]
        self.calls.append(a)
        output = b''
        code = 0
        if a[:2] == ['image', 'inspect']:
            output = json.dumps([{'Id': a[-1], 'Config': {'Env': ['PATH=/usr/bin', 'PGDATA=/var/lib/postgresql/18/docker'], 'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['postgres'], 'User': '', 'Volumes': {'/var/lib/postgresql': {}}}}]).encode()
        elif a == ['volume', 'ls', '--quiet']:
            output = ('source\n' + ((self.volume['Name'] + '\n') if self.volume else '')).encode()
        elif a[:2] == ['volume', 'inspect']:
            output = json.dumps([self.source if a[-1] == 'source' else self.volume]).encode()
        elif a[:2] == ['volume', 'create']:
            self.volume = {'Name': a[-1], 'Driver': 'local', 'Options': None,
                           'Labels': {'username-migration.operation': a[-2].split('=', 1)[1]},
                           'Mountpoint': os.path.join(self.root, 'validation'), 'CreatedAt': 'fixed'}
            code = int(self.fail_after_create)
        elif a[:2] == ['container', 'ls']:
            output = (self.container['Id'] if self.container else '').encode()
        elif a[:2] == ['container', 'inspect']:
            output = json.dumps([self.container]).encode()
        elif a[:2] == ['container', 'create']:
            def arg(option):
                return a[a.index(option) + 1]
            labels = [a[i + 1].split('=', 1) for i, x in enumerate(a) if x == '--label']
            env = ['PATH=/usr/bin', 'PGDATA=/var/lib/postgresql/18/docker'] + [a[i + 1] for i, x in enumerate(a) if x == '--env']
            self.container = {'Id': 'b' * 64, 'Name': '/' + arg('--name'), 'Image': a[-1],
                              'Config': {'Labels': dict(labels), 'Env': env, 'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['postgres'], 'User': ''},
                              'RestartCount': 0,
                              'State': {'Running': False, 'Paused': False, 'Restarting': False, 'StartedAt': 'start-1'},
                              'HostConfig': {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}},
                              'NetworkSettings': {'Networks': {}},
                              'Mounts': [{'Type': 'volume', 'Name': self.volume['Name'],
                                          'Destination': '/var/lib/postgresql', 'RW': True}]}
            code = int(self.fail_after_create)
        elif a[:2] == ['container', 'start']:
            self.container['State']['Running'] = True
        elif a[:1] == ['exec']:
            output = b'postgres|chat|/var/lib/postgresql/18/docker|18|true|12345|2025-01-01 00:00:00+00\n'
        else:
            raise AssertionError(a)
        return SimpleNamespace(returncode=code, stdout=output)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fd = os.open(self.temp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.lock = os.open('lock', os.O_CREAT | os.O_RDWR, 0o600, dir_fd=self.fd)
        self.daemon = Daemon(self.temp.name)
        real_stat = os.stat
        validation_path = os.path.join(self.temp.name, 'validation')
        def fake_stat(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if path == validation_path:
                values = list(result)
                values[2] += 1
                return os.stat_result(values)
            return result
        self.stat_patch = patch('username_migration_validation_pg18.os.stat', side_effect=fake_stat)
        self.stat_patch.start()
        self.kwargs = dict(directory_fd=self.fd, lock_fd=self.lock, operation='operation_123456789',
                           source_volume='source', validation_volume='disposable', image_id='a' * 64,
                           role='chat', gate=lambda: True, runner=self.daemon,
                           approved_image_config={'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['postgres'], 'User': '',
                                                  'Env': ['PATH=/usr/bin', 'PGDATA=/var/lib/postgresql/18/docker']})
        self.obj = DockerValidationLifecycle(**self.kwargs)

    def tearDown(self):
        self.stat_patch.stop()
        os.close(self.lock)
        os.close(self.fd)
        self.temp.cleanup()

    def test_create_resume_and_lost_response(self):
        self.daemon.fail_after_create = True
        self.assertEqual(self.obj.ensure_ready(), 'b' * 64)
        self.assertEqual(self.obj.ensure_ready(), 'b' * 64)
        self.assertEqual(sum(a[:2] == ['volume', 'create'] for a in self.daemon.calls), 1)
        self.assertEqual(sum(a[:2] == ['container', 'create'] for a in self.daemon.calls), 1)
        self.assertTrue(any(a[0] == 'exec' and 'psql' in a and '/proc/1/comm' in ' '.join(a) for a in self.daemon.calls))
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

    def test_caller_lock_is_not_released(self):
        import fcntl
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.obj.ensure_ready()
        other = os.open('lock', os.O_RDWR, dir_fd=self.fd)
        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(other)

    def test_linked_record_recovery(self):
        self.obj.ensure_ready()
        os.link('validation-intent.json', '.validation-' + 'a' * 32, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        self.obj.ensure_ready()
        self.assertFalse(os.path.exists(os.path.join(self.temp.name, '.validation-' + 'a' * 32)))

    def test_image_layout_and_container_mount_are_verified(self):
        original = self.daemon.__call__
        def wrong_image(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3:5] == ['image', 'inspect']:
                image = json.loads(result.stdout)
                image[0]['Config']['Volumes'] = {'/var/lib/postgresql/data': {}}
                result.stdout = json.dumps(image).encode()
            return result
        self.obj.runner = wrong_image
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()
        self.obj.runner = original
        self.obj.ensure_ready()
        self.daemon.container['Mounts'][0]['Destination'] = '/var/lib/postgresql/data'
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()

    def test_temporary_server_retries_until_final(self):
        original = self.daemon.__call__
        attempts = []
        def startup(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3:4] == ['exec']:
                attempts.append(1)
                if len(attempts) < 3:
                    result.returncode = 1
            return result
        self.obj.runner = startup
        with patch('username_migration_validation_pg18.time.sleep'):
            self.assertEqual(self.obj.ensure_ready(), 'b' * 64)
        self.assertEqual(len(attempts), 4)

    def test_preexisting_labeled_volume_is_not_adopted(self):
        self.daemon(['docker', 'x', 'x', 'volume', 'create', '--label',
                     'username-migration.operation=operation_123456789', 'disposable'])
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()
        self.assertFalse(os.path.exists(os.path.join(self.temp.name, 'validation-volume-create-intent.json')))

    def test_distinct_sibling_volumes_on_same_device_are_allowed(self):
        self.stat_patch.stop()
        try:
            self.assertEqual(self.obj.ensure_ready(), 'b' * 64)
        finally:
            self.stat_patch.start()

    def test_source_alias_rejected(self):
        self.daemon.source['Mountpoint'] = os.path.join(self.temp.name, 'validation')
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()

    def test_runtime_drift_rejected(self):
        self.obj.ensure_ready()
        for field, value in [('Entrypoint', ['sh']), ('Cmd', ['sh']), ('User', 'root')]:
            original = self.daemon.container['Config'][field]
            self.daemon.container['Config'][field] = value
            with self.assertRaises(LifecycleError):
                self.obj.ensure_ready()
            self.daemon.container['Config'][field] = original
        self.daemon.container['Config']['Env'].append('LD_PRELOAD=evil')
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()

    def test_unprivileged_and_restart_fail(self):
        original = self.daemon.__call__
        def wrong(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3:4] == ['exec']:
                result.stdout = result.stdout.replace(b'|true|', b'|false|')
            return result
        self.obj.runner = wrong
        with patch('username_migration_validation_pg18.time.sleep'):
            with self.assertRaises(LifecycleError):
                self.obj.ensure_ready()
        def restart(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3:4] == ['exec']:
                self.daemon.container['RestartCount'] += 1
            return result
        self.obj.runner = restart
        with self.assertRaises(LifecycleError):
            self.obj.ensure_ready()

    def test_wrong_database_identity_fails(self):
        original = self.daemon.__call__
        def wrong(argv, **kwargs):
            result = original(argv, **kwargs)
            if argv[3:4] == ['exec']:
                result.stdout = b'postgres|chat|/wrong|18\n'
            return result
        self.obj.runner = wrong
        with patch('username_migration_validation_pg18.time.sleep'):
            with self.assertRaises(LifecycleError):
                self.obj.ensure_ready()


if __name__ == '__main__':
    unittest.main()
