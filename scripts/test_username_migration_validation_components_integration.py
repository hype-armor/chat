"""Disposable PostgreSQL integration; Docker inventory and lifecycle are simulated.

The lifecycle runner uses a real target SQL identity but translates its host data
path and server major to the container values. It does not test Docker, the
entrypoint PID 1 startup, or PostgreSQL 18-specific behavior. Set TEST_PG_ROOT
to a PostgreSQL installation with bin, share/pgsql, lib64.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

import isolated_pg_supervisor as supervisor
from test_username_migration_docker_pg_backup import FakeDocker, CONTAINER, IMAGE, OPERATION, SOURCE
from test_username_migration_validation_pg18 import Daemon
from username_migration_docker_pg_backup import UnverifiedDockerCapture, CaptureError
from username_migration_validation_pg18 import DockerValidationLifecycle, LifecycleError
from username_migration_docker_pg_restore_check import DisposableRestoreCheck, RestoreCheckError

ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))


@unittest.skipUnless((ROOT / 'bin/initdb').is_file(), 'PostgreSQL 18 test binaries unavailable')
class ComponentIntegration(unittest.TestCase):
    def test_disposable_capture_lifecycle_and_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            os.chmod(temp, 0o700)
            fd = os.open(temp, os.O_RDONLY | os.O_DIRECTORY)
            lock = os.open('lock', os.O_CREAT | os.O_RDWR, 0o600, dir_fd=fd)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            params = dict(bindir=str(ROOT / 'bin'), share=str(ROOT / 'share/pgsql'),
                          library_path=str(ROOT / 'lib64'), parent=temp, superuser='app')
            try:
                with supervisor.IsolatedPostgres(**params) as source, supervisor.IsolatedPostgres(**params) as target:
                    def sql(cluster, database, query):
                        return cluster.run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                                                   '-d', database, '-c', query],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
                    source.run('createdb', ['chat'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    sql(source, 'chat', 'CREATE TABLE marker (value integer); INSERT INTO marker VALUES (42);')
                    source_id = sql(source, 'postgres', 'SELECT system_identifier FROM pg_control_system()').decode()
                    target_id = sql(target, 'postgres', 'SELECT system_identifier FROM pg_control_system()').decode()
                    self.assertNotEqual(source_id, target_id)
                    fake = FakeDocker()
                    def capture_runner(args, **kwargs):
                        command = args[3:]
                        if command and command[0] == 'exec':
                            for program in ('psql', 'pg_dump'):
                                if program in command:
                                    return source.run(program, command[command.index(program) + 1:],
                                                      input=kwargs.get('input'), stdout=kwargs.get('stdout'),
                                                      stderr=subprocess.PIPE)
                        return fake(args, **kwargs)
                    capture_args = dict(directory_fd=fd, operation=OPERATION, container_id=CONTAINER,
                                        image_id=IMAGE, volume='synthetic-volume', volume_destination='/data',
                                        stopped_container_ids=[SOURCE], runner=capture_runner)
                    with tempfile.TemporaryDirectory(dir=temp) as rejected:
                        rejected_fd = os.open(rejected, os.O_RDONLY | os.O_DIRECTORY)
                        try:
                            rejected_args = dict(capture_args, directory_fd=rejected_fd)
                            with self.assertRaises(CaptureError):
                                UnverifiedDockerCapture(gate=lambda: False, **rejected_args).capture(database='chat', role='app')
                        finally:
                            os.close(rejected_fd)
                    UnverifiedDockerCapture(gate=lambda: True, **capture_args).capture(database='chat', role='app')
                    metadata = json.loads((Path(temp) / 'postgres-metadata.json').read_text())
                    self.assertEqual(metadata['system_id'], source_id)
                    digest = hashlib.sha256((Path(temp) / 'postgres.dump').read_bytes()).hexdigest()
                    daemon = Daemon(temp)
                    approved = {'Env': ['PATH=/usr/bin', 'PGDATA=/var/lib/postgresql/18/docker'],
                                'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['postgres'], 'User': ''}
                    def lifecycle_runner(args, **kwargs):
                        command = args[3:]
                        if command and command[0] == 'exec':
                            # Execute the component's identity query on the real server.
                            result = target.run('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                                                        '-U', 'app', '-d', 'postgres', '-c', command[-1]],
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                            fields = result.stdout.split(b'|')
                            self.assertEqual(fields[2], target.data.encode())
                            fields[2] = b'/var/lib/postgresql/18/docker'
                            fields[3] = b'18'  # Simulate the approved image boundary.
                            return SimpleNamespace(returncode=0, stdout=b'|'.join(fields))
                        return daemon(args, **kwargs)
                    options = dict(directory_fd=fd, lock_fd=lock, operation=OPERATION,
                                   source_volume='source', validation_volume='disposable', image_id=IMAGE,
                                   role='app', approved_image_config=approved, runner=lifecycle_runner)
                    with self.assertRaises(LifecycleError):
                        DockerValidationLifecycle(gate=lambda: False, **options).ensure_ready()
                    lifecycle = DockerValidationLifecycle(gate=lambda: True, **options)
                    cid = lifecycle.ensure_ready()
                    self.assertEqual(json.loads((Path(temp) / 'validation-cluster.json').read_text())['system_identifier'], target_id)
                    def restore_runner(args, **kwargs):
                        command = args[3:]
                        for program in ('psql', 'pg_restore'):
                            if program in command:
                                opts = {'stdout': kwargs.get('stdout'), 'stderr': subprocess.PIPE}
                                for key in ('stdin', 'input'):
                                    if kwargs.get(key) is not None:
                                        opts[key] = kwargs[key]
                                return target.run(program, command[command.index(program) + 1:], **opts)
                        raise AssertionError(command)
                    check_args = dict(directory_fd=fd, expected_sha256=digest,
                                      selected_database_properties=metadata['selected_database_properties'],
                                      container_id=cid, runner=restore_runner)
                    # Pretend the target is the source: the identity guard must stop before restore.
                    with self.assertRaisesRegex(RestoreCheckError, 'target system identifier mismatch'):
                        DisposableRestoreCheck(expected_source_system_identifier=target_id, gate=lambda: True, **check_args).check()
                    with self.assertRaisesRegex(RestoreCheckError, 'isolation gate failed'):
                        DisposableRestoreCheck(expected_source_system_identifier=source_id, gate=lambda: False, **check_args).check()
                    evidence = DisposableRestoreCheck(expected_source_system_identifier=source_id,
                                                      gate=lambda: True, **check_args).check()
                    self.assertEqual(evidence['status'], 'MATCHED')
                    self.assertEqual(evidence['selected_database_properties'], metadata['selected_database_properties'])
                    self.assertEqual(evidence['target_system_identifier'], target_id)
                    self.assertEqual(sql(target, 'chat', 'SELECT value FROM marker'), b'42')
                    self.assertEqual(sql(source, 'chat', 'SELECT value FROM marker'), b'42')
                    self.assertEqual(sql(source, 'postgres', 'SELECT system_identifier FROM pg_control_system()').decode(), source_id)
            finally:
                os.close(lock)
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
