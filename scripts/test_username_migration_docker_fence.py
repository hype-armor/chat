import copy
import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

from username_migration_systemd_gate import SystemdGate
from username_migration_update_gate import UpdateGate
from username_migration_docker_fence import DockerFence, FenceError


class Gate:
    def __init__(self, operation_id):
        self.operation_id = operation_id
        self.engaged = False
        self.fail = False
    def engage(self, *, resume):
        self.engaged = True
        if self.fail:
            raise RuntimeError()
    def engage_initial(self):
        self.engage(resume=True)
    def verify(self):
        return self.engaged and not self.fail


def container(cid, service, volume=None):
    return {'Id': cid, 'Config': {'Labels': {'com.docker.compose.project': 'chat', 'com.docker.compose.service': service}},
            'State': {'Status': 'running', 'Running': True, 'Paused': False, 'Restarting': False, 'Dead': False, 'ExitCode': 0, 'OOMKilled': False, 'Error': ''},
            'Mounts': [{'Type': 'volume', 'Name': volume}] if volume else [],
            'NetworkSettings': {'Networks': {'chat_net': {}}, 'Ports': {}},
            'HostConfig': {'NetworkMode': 'chat_net', 'RestartPolicy': {'Name': 'always', 'MaximumRetryCount': 0}}}


class Daemon:
    def __init__(self, rows):
        self.rows = {c['Id']: c for c in rows}
        self.calls = []
        self.lose = None
        self.mismatch = False
        self.timeout = False
        self.volume = {'Name': 'pg', 'Driver': 'local', 'Options': None,
                       'Mountpoint': '/var/lib/docker/volumes/pg/_data',
                       'CreatedAt': '2026-01-01T00:00:00Z',
                       'Labels': {'com.docker.compose.project': 'chat'}}
    def __call__(self, args, **kwargs):
        self.calls.append(args)
        assert args[:3] == ['docker', '--host', 'unix:///var/run/docker.sock']
        cmd = args[3:]
        if self.timeout:
            raise subprocess.TimeoutExpired(args, 60)
        if cmd[:3] == ['container', 'ls', '--all']:
            out = '\n'.join(self.rows)
        elif cmd[:2] == ['volume', 'inspect']:
            out = json.dumps([self.volume])
        elif cmd[:2] == ['container', 'inspect']:
            out = json.dumps([self.rows[i] for i in cmd[2:]])
        elif cmd[:2] == ['container', 'update']:
            if not self.mismatch:
                self.rows[cmd[-1]]['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
            out = cmd[-1]
        elif cmd[:2] == ['container', 'stop']:
            self.rows[cmd[-1]]['State'].update(Status='exited', Running=False)
            out = cmd[-1]
        else:
            raise AssertionError(cmd)
        if self.lose == cmd[:2]:
            self.lose = None
            raise subprocess.TimeoutExpired(args, 60)
        return SimpleNamespace(returncode=0, stdout=out)
    def reboot(self):
        for c in self.rows.values():
            if c['HostConfig']['RestartPolicy']['Name'] == 'always':
                c['State'].update(Status='running', Running=True)


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fd = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.ids = {'server': 'b'*64, 'seaweed': 'a'*64, 'db': 'c'*64}
        self.order = ['server', 'seaweed', 'db']
        self.daemon = Daemon([container(self.ids['server'], 'server'), container(self.ids['seaweed'], 'seaweed'), container(self.ids['db'], 'db', 'pg')])
        self.operation = str(uuid.uuid4())
        self.gates = [Gate(self.operation), Gate(self.operation)]
        self.fence = DockerFence(self.fd, 'chat', self.ids, 'db', {'pg'}, {'chat_net'}, 'db', self.gates, self.daemon, operation_id=self.operation, stop_order=self.order, clean_drain_services={'server'})
    def tearDown(self):
        os.close(self.fd); self.tmp.cleanup()
    def test_unclean_and_ambiguous_exit_block_dependencies_and_retry(self):
        for field, value in [('ExitCode', 137), ('OOMKilled', True), ('Error', 'failed'),
                             ('ExitCode', None), ('OOMKilled', None), ('Error', None)]:
            with self.subTest(field=field, value=value):
                self.tearDown()
                self.setUp()
                original = self.daemon.__call__
                def runner(args, **kwargs):
                    result = original(args, **kwargs)
                    if args[3:5] == ['container', 'stop'] and args[-1] == self.ids['server']:
                        self.daemon.rows[args[-1]]['State'][field] = value
                    return result
                self.fence.runner = runner
                with self.assertRaises(FenceError): self.fence.engage()
                with self.assertRaises(FenceError): self.fence.engage()
                stops = [x[-1] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
                self.assertEqual(stops, [self.ids['server']])

    def test_initially_stopped_application_requires_clean_exit(self):
        state = self.daemon.rows[self.ids['server']]['State']
        state.update(Status='exited', Running=False, ExitCode=137, OOMKilled=True, Error='old error')
        with self.assertRaises(FenceError): self.fence.engage()
        self.assertFalse(any(x[3:5] == ['container', 'stop'] for x in self.daemon.calls))
        data = json.loads((Path(self.tmp.name) / 'docker-fence.json').read_text())
        self.assertEqual(data['drain_initially_running'], [])
        state.update(ExitCode=0, OOMKilled=False, Error='')
        self.fence.engage()

    def test_malformed_container_states_block_all_stops(self):
        for service, field, value in [('db', 'Running', 0), ('seaweed', 'Paused', None),
                                      ('server', 'Restarting', 'false')]:
            with self.subTest(service=service, field=field):
                self.tearDown()
                self.setUp()
                self.daemon.rows[self.ids[service]]['State'][field] = value
                with self.assertRaises(FenceError): self.fence.engage()
                self.assertFalse(any(x[3:5] == ['container', 'stop'] for x in self.daemon.calls))

    def test_state_validation_and_stop_boundaries(self):
        valid = {'created': (False, False, False, False),
                 'running': (True, False, False, False),
                 'paused': (True, True, False, False),
                 'restarting': (True, False, True, False),
                 'exited': (False, False, False, False)}
        keys = ('Running', 'Paused', 'Restarting', 'Dead')
        for status, values in valid.items():
            DockerFence._validate_state(dict(Status=status, **dict(zip(keys, values))))
            for index, key in enumerate(keys):
                bad = dict(zip(keys, values))
                bad[key] = not bad[key]
                with self.subTest(status=status, key=key), self.assertRaises(FenceError):
                    DockerFence._validate_state(dict(Status=status, **bad))
        for field in ('Status', *keys):
            for value in (None, 'missing'):
                with self.subTest(field=field, value=value):
                    state = dict(Status='running', Running=True, Paused=False, Restarting=False, Dead=False)
                    if value == 'missing':
                        del state[field]
                    else:
                        state[field] = value
                    with self.assertRaises(FenceError): DockerFence._validate_state(state)
        with self.assertRaisesRegex(FenceError, 'Unsupported Docker container status'):
            DockerFence._validate_state(dict(Status='removing', Running=False, Paused=False, Restarting=False, Dead=False))
        with self.assertRaises(FenceError):
            DockerFence._validate_state(dict(Status='dead', Running=False, Paused=False, Restarting=False, Dead=True))

    def test_ambiguous_state_after_writer_stop_blocks_storage_and_retry(self):
        original = self.daemon.__call__
        def runner(args, **kwargs):
            result = original(args, **kwargs)
            if args[3:5] == ['container', 'stop'] and args[-1] == self.ids['server']:
                self.daemon.rows[args[-1]]['State']['Status'] = 'running'
            return result
        self.fence.runner = runner
        with self.assertRaises(FenceError): self.fence.engage()
        with self.assertRaises(FenceError): self.fence.engage()
        stops = [x[-1] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
        self.assertEqual(stops, [self.ids['server']])

    def test_changed_clean_drain_set_rejected(self):
        self.fence.engage()
        before = len(self.daemon.calls)
        changed = DockerFence(self.fd, 'chat', self.ids, 'db', {'pg'}, {'chat_net'}, 'db',
                              self.gates, self.daemon, operation_id=self.operation,
                              stop_order=self.order, clean_drain_services={'server', 'seaweed'})
        with self.assertRaises(FenceError): changed.engage()
        self.assertFalse(any(x[3:5] in (['container', 'update'], ['container', 'stop'])
                             for x in self.daemon.calls[before:]))

    def test_stop_and_reboot(self):
        self.fence.engage()
        stops = [x[3:] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
        self.assertEqual(stops, [
            ['container', 'stop', '--time', '-1', self.ids['server']],
            ['container', 'stop', '--time', '30', self.ids['seaweed']],
            ['container', 'stop', '--time', '30', self.ids['db']],
        ])
        self.daemon.reboot()
        self.assertTrue(all(not c['State']['Running'] for c in self.daemon.rows.values()))
        self.fence.engage()
    def test_lost_replies_are_retryable(self):
        for action in (['container', 'update'], ['container', 'stop']):
            self.daemon.lose = action
            with self.assertRaises(FenceError): self.fence.engage()
            self.assertTrue(all(g.engaged for g in self.gates))
        self.fence.engage()
    def test_replaced_volume_rejected_on_retry(self):
        self.daemon.lose = ['container', 'stop']
        with self.assertRaises(FenceError):
            self.fence.engage()
        self.daemon.volume['CreatedAt'] = '2026-01-02T00:00:00Z'
        before = len(self.daemon.calls)
        with self.assertRaises(FenceError):
            self.fence.engage()
        self.assertFalse(any(x[3:5] in (['container', 'update'], ['container', 'stop'])
                             for x in self.daemon.calls[before:]))

    def test_replacement_during_shutdown_blocks_next_stop(self):
        original = self.daemon.__call__
        def runner(args, **kwargs):
            result = original(args, **kwargs)
            if args[3:5] == ['container', 'stop']:
                self.daemon.volume['CreatedAt'] = '2026-01-02T00:00:00Z'
            return result
        self.fence.runner = runner
        with self.assertRaises(FenceError):
            self.fence.engage()
        stops = [x[-1] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
        self.assertEqual(stops, [self.ids['server']])

    def test_malformed_volume_identity_rejected(self):
        for field, value in (('CreatedAt', None), ('CreatedAt', ''), ('Labels', []),
                             ('Labels', {'project': None}), ('Mountpoint', 'relative')):
            with self.subTest(field=field, value=value):
                old = self.daemon.volume[field]
                self.daemon.volume[field] = value
                with self.assertRaises(FenceError):
                    self.fence.engage()
                self.daemon.volume[field] = old
        self.assertFalse(any(x[3:5] in (['container', 'update'], ['container', 'stop'])
                             for x in self.daemon.calls))

    def test_invalid_orders_rejected(self):
        for order in ([], ['server', 'db'], ['server', 'server', 'db'],
                      ['server', 'db', 'seaweed'], ['server', 'other', 'db'], None):
            with self.subTest(order=order), self.assertRaises(FenceError):
                DockerFence(self.fd, 'chat', self.ids, 'db', {'pg'}, {'chat_net'},
                            'db', self.gates, self.daemon, operation_id=self.operation,
                            stop_order=order, clean_drain_services={'server'})
        self.assertFalse(self.daemon.calls)

    def test_changed_order_and_legacy_journal_rejected(self):
        self.fence.engage()
        before = len(self.daemon.calls)
        changed = DockerFence(self.fd, 'chat', self.ids, 'db', {'pg'}, {'chat_net'},
                              'db', self.gates, self.daemon, operation_id=self.operation,
                              stop_order=['seaweed', 'server', 'db'], clean_drain_services={'server'})
        with self.assertRaises(FenceError):
            changed.engage()
        self.assertFalse(any(x[3:5] in (['container', 'update'], ['container', 'stop'])
                             for x in self.daemon.calls[before:]))
        path = Path(self.tmp.name) / 'docker-fence.json'
        data = json.loads(path.read_text())
        data['version'] = 3
        data['volumes'] = ['pg']
        path.write_text(json.dumps(data))
        with self.assertRaises(FenceError):
            self.fence.engage()

    def test_stop_lost_reply_does_not_stop_dependencies(self):
        self.daemon.lose = ['container', 'stop']
        with self.assertRaises(FenceError):
            self.fence.engage()
        stops = [x[-1] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
        self.assertEqual(stops, [self.ids['server']])
        self.fence.engage()
        stops = [x[-1] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
        self.assertEqual(stops, [self.ids['server'], *[self.ids[s] for s in self.order]])

    def test_writer_timeout_blocks_storage_until_delayed_clean_exit(self):
        original = self.daemon.__call__
        def runner(args, **kwargs):
            if args[3:5] == ['container', 'stop'] and args[-1] == self.ids['server']:
                self.assertEqual(kwargs['timeout'], 60)
                if self.daemon.rows[self.ids['server']]['State']['Running']:
                    self.daemon.calls.append(args)
                    raise subprocess.TimeoutExpired(args, kwargs['timeout'])
            return original(args, **kwargs)
        self.fence.runner = runner
        # The daemon can continue waiting after the client times out. Repeated
        # retries must not stop either storage service while the writer runs.
        for _ in range(2):
            with self.assertRaises(FenceError):
                self.fence.engage()
            stops = [x[3:] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
            self.assertTrue(all(x == ['container', 'stop', '--time', '-1', self.ids['server']]
                                for x in stops))
            self.assertTrue(stops)
        self.daemon.rows[self.ids['server']]['State'].update(Status='exited', Running=False)
        self.fence.engage()
        stops = [x[3:] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
        self.assertEqual(stops[-2:], [
            ['container', 'stop', '--time', '30', self.ids['seaweed']],
            ['container', 'stop', '--time', '30', self.ids['db']],
        ])

    def test_unverified_stop_blocks_dependencies(self):
        original = self.daemon.__call__
        def runner(args, **kwargs):
            result = original(args, **kwargs)
            if args[3:5] == ['container', 'stop']:
                self.daemon.rows[args[-1]]['State'].update(Status='running', Running=True)
            return result
        self.fence.runner = runner
        with self.assertRaises(FenceError):
            self.fence.engage()
        stops = [x[-1] for x in self.daemon.calls if x[3:5] == ['container', 'stop']]
        self.assertEqual(stops, [self.ids['server']])

    def test_unknown_volume_and_direct_ingress(self):
        other = container('d'*64, 'other', 'pg')
        other['Config']['Labels'] = {}
        other['NetworkSettings']['Networks'] = {}
        self.daemon.rows[other['Id']] = other
        with self.assertRaises(FenceError): self.fence.engage()
        other['Mounts'] = [{'Type': 'bind', 'Source': '/var/lib/docker/volumes/pg'}]
        with self.assertRaises(FenceError): self.fence.engage()
        other['Mounts'] = []
        other['NetworkSettings']['Ports'] = {'8080/tcp': [{'HostPort': '8080'}]}
        with self.assertRaises(FenceError): self.fence.engage()
        self.assertFalse(any(x[3:5] == ['container', 'stop'] for x in self.daemon.calls))
    def test_stopped_unknown_automatic_restart_is_rejected(self):
        other = container('d'*64, 'other', 'pg')
        other['Config']['Labels'] = {}
        other['NetworkSettings']['Networks'] = {}
        other['State'].update(Status='exited', Running=False)
        self.daemon.rows[other['Id']] = other
        with self.assertRaises(FenceError): self.fence.engage()
        self.assertFalse(any(x[3:5] == ['container', 'stop'] for x in self.daemon.calls))
    def test_gate_and_timeout_and_mismatch(self):
        self.gates[1].fail = True
        with self.assertRaises(FenceError): self.fence.engage()
        self.assertFalse(self.daemon.calls)
        self.gates[1].fail = False
        self.daemon.timeout = True
        with self.assertRaises(FenceError): self.fence.engage()
        self.daemon.timeout = False
        self.daemon.mismatch = True
        with self.assertRaises(FenceError): self.fence.engage()
        self.assertFalse(any(x[3:5] == ['container', 'stop'] for x in self.daemon.calls))
    def test_real_gate_adapters_with_fake_manager_and_daemon(self):
        root = Path(self.tmp.name)
        (root / 'state').mkdir(mode=0o700)
        (root / 'unit').mkdir(mode=0o700)
        marker = root / 'state' / 'systemd-marker'
        dropin = root / 'unit' / 'gate.conf'
        dropin.write_text('[Unit]\nConditionPathExists=!' + str(marker) + '\n')
        def manager(args):
            if args == ['daemon-reload']:
                return ''
            return ('LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n'
                    f'DropInPaths={dropin}\nConditions={{ type=ConditionPathExists ; '
                    f'trigger=no ; negate=yes ; path={marker} ; state=failed }}\n')
        operation = str(uuid.uuid4())
        update_gate = UpdateGate(self.fd, operation)
        systemd_gate = SystemdGate(operation, runner=manager, marker=str(marker),
                                   dropin=str(dropin), trusted_root=str(root))
        fence = DockerFence(self.fd, 'chat', self.ids, 'db', {'pg'}, {'chat_net'}, 'db',
                            [update_gate, systemd_gate], self.daemon, operation_id=operation, stop_order=self.order, clean_drain_services={'server'})
        fence.engage()
        self.assertTrue(update_gate.verify())
        self.assertTrue(systemd_gate.verify())
        self.assertTrue(all(not row['State']['Running'] for row in self.daemon.rows.values()))

    def test_retained_dropin_allows_new_operation(self):
        root = Path(self.tmp.name)
        (root / 'state').mkdir(mode=0o700)
        (root / 'unit').mkdir(mode=0o700)
        (root / 'next').mkdir(mode=0o700)
        marker, dropin = root / 'state' / 'systemd-marker', root / 'unit' / 'gate.conf'
        def manager(args):
            if args == ['daemon-reload']:
                return ''
            return ('LoadState=loaded\nFragmentPath=/etc/systemd/system/pi-chat.service\n'
                    f'DropInPaths={dropin}\nConditions={{ type=ConditionPathExists ; '
                    f'trigger=no ; negate=yes ; path={marker} ; state=failed }}\n')
        # Simulate a persistent drop-in left by an earlier completed rollback.
        dropin.write_text('[Unit]\nConditionPathExists=!' + str(marker) + '\n')
        operation = str(uuid.uuid4())
        update_gate = UpdateGate(self.fd, operation)
        systemd_gate = SystemdGate(operation, runner=manager, marker=str(marker),
                                   dropin=str(dropin), trusted_root=str(root))
        next_fd = os.open(root / 'next', os.O_RDONLY | os.O_DIRECTORY)
        try:
            fence = DockerFence(next_fd, 'chat', self.ids, 'db', {'pg'}, {'chat_net'}, 'db',
                                [update_gate, systemd_gate], self.daemon, operation_id=operation, stop_order=self.order, clean_drain_services={'server'})
            fence.engage()
            self.assertTrue(systemd_gate.verify())
        finally:
            os.close(next_fd)

    def test_missing_gate_after_intent_is_not_recreated(self):
        self.fence.engage()
        self.gates[0].engaged = False
        before = len(self.daemon.calls)
        with self.assertRaises(FenceError):
            self.fence.engage()
        self.assertFalse(self.gates[0].engaged)
        self.assertEqual(len(self.daemon.calls), before)

    def test_external_db_rejected(self):
        with self.assertRaises(FenceError):
            DockerFence(self.fd, 'chat', self.ids, 'db', {'pg'}, {'chat_net'}, 'remote', self.gates, self.daemon, operation_id=self.operation, stop_order=self.order, clean_drain_services={'server'})


if __name__ == '__main__':
    unittest.main()
