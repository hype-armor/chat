#!/usr/bin/env python3
"""Offline tests. No Docker Engine socket, image pulls, or running containers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import username_migration_compose_rehearsal as fixture


PROJECT = 'chat-fence-' + 'a' * 20
REFS = {key: label + '@sha256:' + str(i) * 64 for i, (key, label) in enumerate(fixture.IMAGES.items(), 1)}
SPEC = fixture.plan(PROJECT, REFS)
NETWORK = 'b' * 64
IMAGE_IDS = {ref: 'sha256:' + str(i) * 64 for i, ref in enumerate(REFS.values(), 5)}


class InterruptedCreate(Exception):
    pass


class FakeEngine:
    def __init__(self, work):
        self.work, self.data = work, work / 'engine-data'
        self.rows = {}
        self.volumes = {}
        self.log = []
        self.writer_net = False
        self.interrupt = False
        self.outside_pg_error = 'connection to server failed: Connection refused'
        self.outside_s3_result = (7, '\n000 0.000000', 'connection refused')
        self.private_s3 = {'/fence-fixture/baseline': PROJECT + '-before-fence'}
        self.private_pg = {'before': PROJECT + '-before-fence'}

    def create(self, project, *services):
        assert project == PROJECT
        self.log.append(('create', *services))
        for name in services:
            if name in self.rows:
                continue
            spec = SPEC['services'][name]
            cid = f'{len(self.rows) + 1:064x}'
            mode = spec.get('network_mode', PROJECT + '_writers')
            if 'networks' in spec:
                self.writer_net = True
            if name == 'inside-s3':
                mode = 'container:' + self.rows['maint-s3']['Id']
            mounts = []
            for item in spec.get('volumes', []):
                logical, target = item.split(':')
                volume = PROJECT + '_' + logical
                source = str(self.data / 'volumes' / volume / '_data')
                self.volumes.setdefault(volume, {'Name': volume, 'Driver': 'local', 'Scope': 'local',
                                                 'Labels': {'chat.fence.fixture': PROJECT,
                                                            'com.docker.compose.project': PROJECT},
                                                 'Mountpoint': source, 'CreatedAt': 'fixture-created'})
                mounts.append({'Name': volume, 'Source': source, 'Destination': target,
                               'Type': 'volume', 'Driver': 'local', 'RW': True})
            self.rows[name] = {'Id': cid, 'Image': IMAGE_IDS[spec['image']], 'Mounts': mounts,
                               'Config': {'Labels': {'com.docker.compose.project': PROJECT,
                                                     'chat.fence.fixture': PROJECT,
                                                     'com.docker.compose.service': name},
                                          'Env': [f'{k}={v}' for k, v in spec.get('environment', {}).items()],
                                          'Entrypoint': spec.get('entrypoint'), 'Cmd': spec.get('command')},
                               'HostConfig': {'NetworkMode': mode, 'RestartPolicy': {'Name': 'no'},
                                              'Tmpfs': {t: '' for t in spec.get('tmpfs', [])}, 'IpcMode': 'private',
                                              'ExtraHosts': spec.get('extra_hosts') or []},
                               'NetworkSettings': {'Networks': {}}, 'State': {'Running': False, 'Pid': 0, 'ExitCode': 0}}
            if self.interrupt:
                self.interrupt = False
                raise InterruptedCreate()

    def ids(self, command, *args):
        return {'container': [row['Id'] for row in self.rows.values()],
                'network': ['host', 'bridge', 'none'] + ([PROJECT + '_writers'] if self.writer_net else []),
                'volume': list(self.volumes)}[command]

    def json(self, command, operation, *args):
        assert operation == 'inspect'
        if command == 'container':
            return [row for row in self.rows.values() if row['Id'] in args]
        if command == 'volume':
            return [self.volumes[args[0]]]
        assert command == 'network'
        return [{'Id': NETWORK, 'Name': PROJECT + '_writers', 'Driver': 'bridge', 'Internal': True,
                 'Labels': {'chat.fence.fixture': PROJECT, 'com.docker.compose.project': PROJECT},
                 'IPAM': {'Config': [{'Subnet': '172.29.227.0/24', 'IPRange': '172.29.227.128/25'}]},
                 'Containers': {row['Id']: {} for row in self.rows.values() if row['State']['Running']
                                and row['HostConfig']['NetworkMode'] == PROJECT + '_writers'}}]

    def run(self, command, operation, *args, allow_failure=False):
        assert command == 'container'
        cid = args[0] if operation == 'exec' else args[-1]
        name, row = next((name, row) for name, row in self.rows.items() if row['Id'] == cid)
        self.log.append((operation, name, *args[1:]) if operation == 'exec' else (operation, name))
        if operation == 'exec':
            assert allow_failure and row['State']['Running']
            code, output, error = self.probe(name, args[1:])
            return subprocess.CompletedProcess(args, code, output, error)
        assert operation in ('start', 'stop')
        state = operation == 'start'
        row['State'].update(Running=state, Pid=42 if state else 0)
        net = row['HostConfig']['NetworkMode']
        if net == PROJECT + '_writers':
            ip = SPEC['services'][name]['networks']['writers'].get('ipv4_address') or '172.29.227.130'
            row['NetworkSettings']['Networks'] = {net: {'NetworkID': NETWORK, 'IPAddress': ip}} if state else {}

    def probe(self, name, args):
        marker = PROJECT + '-before-fence'
        if args[0] == 'env':
            assert 'PGPASSWORD=' + fixture.PG_SECRET in args
            sql = args[-1]
            if name == 'outside-pg':
                return 2, '', self.outside_pg_error
            assert name == 'maint-pg'
            if 'SELECT 1;' in sql:
                return 0, '1\n', ''
            if 'pg_control_system' in sql:
                key = 'maintenance' if "k='maintenance'" in sql else 'before'
                return 0, '7312345678901234567\n' + self.private_pg.get(key, '') + '\n', ''
            if "k='outside'" in sql:
                return 0, '0\n', ''
            assert "'maintenance'" in sql
            self.private_pg['maintenance'] = marker
            return 0, marker + '\nINSERT 0 1\n', ''
        method = args[args.index('-X') + 1]
        url = args[-1]
        if name == 'outside-s3':
            if method == 'PUT':
                assert fixture.S3_IP in url and url.endswith('/outside')
                return self.outside_s3_result
            assert method == 'GET' and url in {f'http://{ip}:{port}/' for ip, port in
                                                 ((fixture.APP_IP, 8080), (fixture.S3_IP, 9333),
                                                  (fixture.S3_IP, 8888), (fixture.S3_IP, 8080))}
            return 7, '\n000 0.000000', 'connection refused'
        assert name == 'inside-s3' and url.startswith('http://127.0.0.1:8333/')
        path = url.split(':8333', 1)[1]
        if method == 'PUT':
            self.private_s3[path] = args[args.index('--data-binary') + 1]
            return 0, '\n200', ''
        return 0, self.private_s3[path] + '\n200' if path in self.private_s3 else '\n404', ''


class RehearsalTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.engine = FakeEngine(Path(temp.name))
        self.run_fixture = fixture.Rehearsal(self.engine, {'images': IMAGE_IDS, 'containers': {}}, SPEC)
        self.engine.create(PROJECT, *fixture.ORIGINALS)
        rows, network, volumes = self.run_fixture.inventory(allow_partial=True)
        self.run_fixture.save('baseline', containers={k: r['Id'] for k, r in rows.items()}, network=network,
                              volumes=volumes)
        self.run_fixture.operation('start', fixture.ORIGINALS)
        self.run_fixture.save('fencing', marker=PROJECT + '-before-fence', pg_system='7312345678901234567')
        self.engine.log.clear()

    def test_exact_stop_order_and_maintenance_proof(self):
        self.run_fixture.continue_run()
        self.assertEqual(self.engine.log[:4], [('stop', 'app'), ('stop', 's3'), ('stop', 'pg'), ('create', *fixture.MAINT)])
        journal = json.loads((self.engine.work / 'journal.json').read_text())
        self.assertEqual(journal['phase'], 'proven')
        self.assertTrue(journal['fence_proof']['same_cluster_and_baseline'])
        attempts = [args for op, name, *args in self.engine.log if op == 'exec' and name == 'outside-s3']
        self.assertEqual(len(attempts), 6)
        self.assertIn('--aws-sigv4', attempts[0])
        self.assertTrue(any(arg.startswith('x-amz-content-sha256: ') for arg in attempts[0]))
        self.assertTrue(all('--aws-sigv4' not in args for args in attempts[1:]))

    def test_interrupted_maintenance_creation_refuses_resume_and_abort(self):
        self.engine.interrupt = True
        with self.assertRaises(InterruptedCreate):
            self.run_fixture.continue_run()
        journal = json.loads((self.engine.work / 'journal.json').read_text())
        self.assertEqual(journal['phase'], 'fenced')
        self.assertEqual(journal['pending'], ['create', *fixture.MAINT])
        self.assertFalse(self.engine.rows['maint-pg']['State']['Running'])
        restarted_owner = fixture.Rehearsal(self.engine, journal, SPEC)
        before = self.engine.log.copy()
        for action in (restarted_owner.continue_run, restarted_owner.abort):
            with self.assertRaisesRegex(fixture.Refusal, 'Unresolved Docker mutation'):
                action()
        self.assertEqual(self.engine.log, before)

    def test_resume_from_known_fenced_checkpoint(self):
        self.run_fixture.operation('stop', fixture.WRITERS)
        self.run_fixture.save('fenced')
        self.engine.log.clear()
        self.run_fixture.continue_run()
        self.assertEqual(self.run_fixture.journal['phase'], 'proven')
        self.assertEqual(self.engine.log[0], ('create', *fixture.MAINT))
        self.assertFalse(any(row['State']['Running'] for name, row in self.engine.rows.items() if name in fixture.WRITERS))

    def test_original_writer_cannot_start_after_fencing_intent(self):
        for phase in ('fencing', 'fenced', 'maintenance', 'reboot-check', 'aborted'):
            self.run_fixture.save(phase)
            with self.assertRaisesRegex(fixture.Refusal, 'can start only during baseline'):
                self.run_fixture.operation('start', ('app',))
        self.assertEqual(self.engine.log, [])

    def test_persistent_restart_drift_prevents_maintenance(self):
        self.engine.rows['app']['HostConfig']['RestartPolicy']['Name'] = 'always'
        with self.assertRaisesRegex(fixture.Refusal, 'restart settings'):
            self.run_fixture.continue_run()
        self.assertEqual(self.engine.log, [])

    def test_wrong_storage_identity_refuses_any_action(self):
        self.engine.volumes[PROJECT + '_pgdata']['CreatedAt'] = 'replacement-volume'
        with self.assertRaisesRegex(fixture.Refusal, 'Recorded object'):
            self.run_fixture.continue_run()
        self.assertEqual(self.engine.log, [])

    def test_refuses_private_listener_on_writer_network(self):
        with patch.object(self.run_fixture, 'prove', side_effect=fixture.Refusal('pause')):
            with self.assertRaisesRegex(fixture.Refusal, 'pause'):
                self.run_fixture.continue_run()
        self.engine.rows['maint-s3']['NetworkSettings']['Networks'][PROJECT + '_writers'] = {}
        with self.assertRaisesRegex(fixture.Refusal, 'extra network attachment'):
            self.run_fixture.continue_run()

    def test_private_store_hosts_mapping_drift_refuses_proof(self):
        self.run_fixture.continue_run()
        self.engine.rows['maint-s3']['HostConfig']['ExtraHosts'] = [fixture.S3_HOST + ':' + fixture.S3_IP]
        with self.assertRaisesRegex(fixture.Refusal, 'hosts mapping changed'):
            self.run_fixture.inventory()

    def test_outside_auth_failure_is_not_proof(self):
        for store, s3_result in (('pg', (7, '\n000 0.000000', 'refused')), ('s3', (0, '\n403', '')),
                                 ('connected-s3-timeout', (28, '\n000 0.100000', 'timed out'))):
            with self.subTest(store=store):
                self.engine.outside_s3_result = s3_result
                self.engine.outside_pg_error = 'password authentication failed' if store == 'pg' else 'Connection refused'
                with self.assertRaisesRegex(fixture.Refusal, 'verified connection failure'):
                    self.run_fixture.continue_run()
                self.assertEqual(self.run_fixture.journal['phase'], 'maintenance')

    def test_reboot_requires_changed_boot_and_stopped_originals_then_preserves_canaries(self):
        self.run_fixture.continue_run()
        self.run_fixture.save('awaiting-reboot', reboot_from='before')
        with patch.object(fixture, 'current_boot', return_value='before'):
            with self.assertRaisesRegex(fixture.Refusal, 'Externally reboot'):
                self.run_fixture.continue_run()
        with patch.object(fixture, 'current_boot', return_value='after'):
            with self.assertRaisesRegex(fixture.Refusal, 'restarted without the owner'):
                self.run_fixture.continue_run()
            self.run_fixture.operation('stop', tuple(reversed(fixture.MAINT)) + fixture.OBSERVERS)
            self.run_fixture.continue_run()
        self.assertEqual(self.run_fixture.journal['phase'], 'reboot-proven')
        self.assertEqual(self.run_fixture.journal['reboot_proof']['boot'], 'after')

    def test_abort_stops_but_does_not_delete_or_start(self):
        self.run_fixture.continue_run()
        recorded = set(self.engine.rows)
        self.engine.log.clear()
        self.run_fixture.abort()
        self.run_fixture.abort()
        self.assertEqual(self.run_fixture.journal['phase'], 'aborted')
        self.assertEqual(set(self.engine.rows), recorded)
        self.assertEqual([action for action, _ in self.engine.log], ['stop'] * 5)
        with self.assertRaisesRegex(fixture.Refusal, 'cannot resume'):
            self.run_fixture.continue_run()


class StaticTest(unittest.TestCase):
    def test_single_log_file_disables_compression(self):
        expected = {'driver': 'local', 'options': {'max-size': '1m', 'max-file': '1', 'compress': 'false'}}
        for name, service in SPEC['services'].items():
            with self.subTest(service=name):
                self.assertEqual(service['logging'], expected)

    def test_rejects_mutable_or_wrong_version_images(self):
        for value in ['docker.io/library/postgres:18.6', 'docker.io/library/postgres:latest@sha256:' + 'b' * 64]:
            with self.assertRaisesRegex(fixture.Refusal, 'Wrong version or missing digest'):
                fixture.plan(PROJECT, REFS | {'pg': value})

    def test_cli_opt_in_refuses_before_engine_construction(self):
        with patch.object(sys, 'argv', ['script', 'run']), patch.object(fixture, 'Engine') as engine:
            with self.assertRaisesRegex(fixture.Refusal, 'Explicit disposable guest'):
                fixture.main()
            engine.assert_not_called()

    def test_default_socket_symlink_is_refused_without_connecting(self):
        with tempfile.TemporaryDirectory() as path:
            work = Path(path)
            (work / 'engine-data').mkdir(mode=0o700)
            (work / 'engine.sock').symlink_to('/run/docker.sock')
            real_guard = fixture.private_file

            def fake_guard(p, kind, mode):
                # Only directory ownership is bypassed. Real lstat rejects the socket link.
                return p.lstat() if kind is fixture.stat.S_ISDIR else real_guard(p, kind, mode)

            with patch.object(fixture.os, 'getuid', return_value=12345), \
                 patch.object(fixture, 'private_file', side_effect=fake_guard), \
                 patch.object(fixture.socket, 'socket') as connect:
                with self.assertRaisesRegex(fixture.Refusal, 'Unsafe fixture path: engine.sock'):
                    fixture.Engine(work)
                connect.assert_not_called()

    @unittest.skipUnless(shutil.which('docker'), 'Docker CLI not installed (offline Compose validation only)')
    def test_compose_compiles_without_daemon(self):
        with tempfile.TemporaryDirectory() as path:
            work = Path(path)
            spec = work / 'fixture.json'
            spec.write_text(json.dumps(SPEC), encoding='utf-8')
            absent = work / 'absent.sock'
            cmd = [shutil.which('docker'), '--host', f'unix://{absent}', 'compose', '--env-file', '/dev/null',
                   '--file', str(spec), 'config', '--format', 'json']
            result = subprocess.run(cmd, capture_output=True, check=False, text=True, timeout=10,
                                    env={'HOME': path, 'DOCKER_CONFIG': path, 'PATH': os.defpath, 'COMPOSE_DISABLE_ENV_FILE': '1'})
            if "'compose' is not a docker command" in result.stderr:
                self.skipTest('Compose CLI plugin not installed')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(absent.exists())
            compiled = json.loads(result.stdout)
            self.assertEqual(compiled['name'], PROJECT)
            for name, service in compiled['services'].items():
                self.assertEqual(service['image'], SPEC['services'][name]['image'])
                self.assertEqual(service['pull_policy'], 'never')
                self.assertEqual(service['restart'], 'no')
                self.assertEqual(service['logging'], SPEC['services'][name]['logging'])
                self.assertFalse({'ports', 'build', 'privileged'} & service.keys())
            self.assertTrue(compiled['networks']['writers']['internal'])
            self.assertEqual(compiled['services']['maint-s3']['network_mode'], 'none')
            self.assertEqual(compiled['services']['maint-pg']['network_mode'], 'none')
            self.assertEqual(compiled['services']['inside-s3']['network_mode'], 'service:maint-s3')
            self.assertEqual(compiled['services']['s3']['command'], SPEC['services']['s3']['command'])
            for service, ip in (('s3', fixture.S3_IP), ('maint-s3', '127.0.0.1')):
                config = compiled['services'][service]
                self.assertEqual(config['extra_hosts'], [fixture.S3_HOST + '=' + ip])
                self.assertIn('-ip=' + fixture.S3_HOST + ' ', config['command'][0])
                self.assertIn('-ip.bind=' + ip + ' ', config['command'][0])


if __name__ == '__main__':
    unittest.main()
