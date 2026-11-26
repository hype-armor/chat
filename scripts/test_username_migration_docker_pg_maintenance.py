import json
import os
import tempfile
import unittest
from types import SimpleNamespace

from username_migration_docker_pg_maintenance import DockerPostgresMaintenance, MaintenanceError


class Daemon:
    def __init__(self):
        self.rows = {}
        self.lost = set()
        self.calls = []
        self.hook = None

    def __call__(self, command, **kwargs):
        a = command[3:]
        self.calls.append(a)
        out = b''
        if a[:2] == ['volume', 'inspect']:
            out = json.dumps([{'Name': 'pg', 'Driver': 'local', 'Options': {}, 'Mountpoint': '/var/lib/docker/volumes/pg/_data'}]).encode()
        elif a[:2] == ['container', 'ls']:
            out = ('\n'.join(self.rows)).encode()
        elif a[:2] == ['container', 'inspect']:
            out = json.dumps([self.rows[i] for i in a[2:]]).encode()
        elif a[:2] == ['container', 'create']:
            cid = 'a' * 64
            self.rows[cid] = {'Id': cid, 'Name': '/' + a[3], 'Image': a[-1],
                              'Config': {'Labels': {'username-migration.operation': a[5].split('=', 1)[1]}},
                              'State': {'Running': False, 'Paused': False, 'Restarting': False},
                              'HostConfig': {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}},
                              'NetworkSettings': {'Networks': {}},
                              'Mounts': [{'Type': 'volume', 'Name': 'pg', 'Destination': '/var/lib/postgresql', 'RW': True}]}
        elif a[:2] == ['container', 'start']:
            self.rows[a[2]]['State']['Running'] = True
        elif a[:2] == ['container', 'stop']:
            self.rows[a[2]]['State']['Running'] = False
        elif a[:2] == ['container', 'rm']:
            del self.rows[a[2]]
        elif a[0] != 'exec':
            raise AssertionError(a)
        if self.hook:
            self.hook(a)
        key = tuple(a[:2])
        failed = key in self.lost
        self.lost.discard(key)
        return SimpleNamespace(returncode=int(failed), stdout=out)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fd = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.daemon = Daemon()
        self.gate = True
        self.m = DockerPostgresMaintenance(directory_fd=self.fd, operation='operation_123456789', image_id='b'*64,
                                           volume='pg', stopped_container_ids=[], gate=lambda: self.gate, runner=self.daemon)

    def tearDown(self):
        os.close(self.fd)
        self.tmp.cleanup()

    def test_lost_replies_and_retry(self):
        self.daemon.lost = {('container', 'create'), ('container', 'start')}
        cid = self.m.ensure_ready()
        self.assertEqual(cid, 'a'*64)
        self.assertEqual(self.m.ensure_ready(), cid)
        self.assertEqual(sum(a[:2] == ['container', 'create'] for a in self.daemon.calls), 1)
        self.assertEqual(os.stat('postgres-maintenance.json', dir_fd=self.fd).st_mode & 0o777, 0o600)

    def test_publication_crash_retry(self):
        # Exit without Python cleanup at each publication boundary.
        for target, prefix in [('postgres-maintenance.json', '.maintenance-'),
                               ('postgres-maintenance-id', '.maintenance-id-')]:
            for point in ('before-link', 'after-link', 'after-unlink'):
                with self.subTest(target=target, point=point), tempfile.TemporaryDirectory() as directory:
                    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        m = DockerPostgresMaintenance(directory_fd=fd, operation='operation_123456789',
                            image_id='b'*64, volume='pg', stopped_container_ids=[], gate=lambda: True,
                            runner=self.daemon)
                        pid = os.fork()
                        if pid == 0:
                            original_link, original_unlink = os.link, os.unlink
                            def link(src, dst, **kwargs):
                                if point == 'before-link': os._exit(71)
                                result = original_link(src, dst, **kwargs)
                                if point == 'after-link': os._exit(71)
                                return result
                            def unlink(path, **kwargs):
                                result = original_unlink(path, **kwargs)
                                if path.startswith(prefix) and point == 'after-unlink': os._exit(71)
                                return result
                            os.link, os.unlink = link, unlink
                            (m._intent() if target.endswith('.json') else m._bind_id('a'*64))
                            os._exit(72)
                        _, status = os.waitpid(pid, 0)
                        self.assertEqual(os.waitstatus_to_exitcode(status), 71)
                        if target.endswith('.json'):
                            m._intent()
                            m._intent()
                        else:
                            m._bind_id('a'*64)
                            m._bind_id('a'*64)
                            with self.assertRaises(MaintenanceError): m._bind_id('d'*64)
                        self.assertEqual(os.stat(target, dir_fd=fd).st_nlink, 1)
                    finally:
                        os.close(fd)

    def test_unexpected_hard_links_fail_closed(self):
        for target, prefix in [('postgres-maintenance.json', '.maintenance-'),
                               ('postgres-maintenance-id', '.maintenance-id-')]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    m = DockerPostgresMaintenance(directory_fd=fd, operation='operation_123456789',
                        image_id='b'*64, volume='pg', stopped_container_ids=[], gate=lambda: True,
                        runner=self.daemon)
                    check = m._intent if target.endswith('.json') else lambda: m._bind_id('a'*64)
                    check()
                    os.link(target, 'unexpected', src_dir_fd=fd, dst_dir_fd=fd)
                    with self.assertRaises(MaintenanceError): check()
                    os.unlink('unexpected', dir_fd=fd)
                    os.link(target, prefix + '0'*32, src_dir_fd=fd, dst_dir_fd=fd)
                    os.link(target, 'unexpected', src_dir_fd=fd, dst_dir_fd=fd)
                    with self.assertRaises(MaintenanceError): check()
                    self.assertEqual(os.stat(target, dir_fd=fd).st_nlink, 3)
                finally:
                    os.close(fd)

    def test_recovery_checks_identity_before_unlink(self):
        self.m._intent()
        self.m._bind_id('a'*64)
        for target, prefix, check in [
            ('postgres-maintenance.json', '.maintenance-', lambda: setattr(self.m, 'image', 'c'*64) or self.m._intent()),
            ('postgres-maintenance-id', '.maintenance-id-', lambda: self.m._bind_id('d'*64)),
        ]:
            link = prefix + '0'*32
            os.link(target, link, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            with self.assertRaises(MaintenanceError): check()
            self.assertEqual(os.stat(target, dir_fd=self.fd).st_nlink, 2)
            self.assertEqual(os.stat(link, dir_fd=self.fd).st_nlink, 2)

    def test_reject_bind_alias_and_restartable_volume(self):
        self.m.ensure_ready()
        other = json.loads(json.dumps(self.daemon.rows['a'*64]))
        other['Id'] = 'c'*64
        other['Config']['Labels'] = {}
        other['Mounts'] = [{'Type': 'bind', 'Source': '/var/lib/docker/volumes/pg'}]
        self.daemon.rows[other['Id']] = other
        with self.assertRaises(MaintenanceError): self.m.ensure_ready()
        other['State']['Running'] = False
        other['HostConfig']['RestartPolicy']['Name'] = 'always'
        other['Mounts'] = [{'Type': 'volume', 'Name': 'pg'}]
        with self.assertRaises(MaintenanceError): self.m.ensure_ready()

    def test_reject_modified_container_and_gate(self):
        self.m.ensure_ready()
        self.daemon.rows['a'*64]['HostConfig']['NetworkMode'] = 'host'
        with self.assertRaises(MaintenanceError): self.m.ensure_ready()
        self.daemon.rows['a'*64]['HostConfig']['NetworkMode'] = 'none'
        self.gate = False
        with self.assertRaises(MaintenanceError): self.m.ensure_ready()

    def test_rollback_only_and_lost_responses(self):
        self.m.ensure_ready()
        with self.assertRaises(MaintenanceError): self.m.rollback_remove(lambda: False)
        self.daemon.lost = {('container', 'stop'), ('container', 'rm')}
        self.m.rollback_remove(lambda: True)
        self.m.rollback_remove(lambda: True)
        self.assertEqual(self.daemon.rows, {})

    def test_changed_intent_fails_before_effect(self):
        self.m.ensure_ready()
        self.m.image = 'c'*64
        with self.assertRaises(MaintenanceError): self.m.ensure_ready()

    def test_replacement_id_is_rejected(self):
        self.m.ensure_ready()
        row = self.daemon.rows.pop('a'*64)
        row['Id'] = 'd'*64
        self.daemon.rows[row['Id']] = row
        with self.assertRaises(MaintenanceError): self.m.ensure_ready()
        with self.assertRaises(MaintenanceError): self.m.rollback_remove(lambda: True)

    def test_gate_loss_after_start_fails(self):
        def hook(a):
            if a[:2] == ['container', 'start']:
                self.gate = False
        self.daemon.hook = hook
        with self.assertRaises(MaintenanceError): self.m.ensure_ready()
        self.assertFalse(any(a[0] == 'exec' for a in self.daemon.calls))


if __name__ == '__main__':
    unittest.main()
