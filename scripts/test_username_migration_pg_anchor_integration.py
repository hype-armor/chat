"""Synthetic integration only: real private PostgreSQL, simulated Docker.

This checks an explicit test-only migration gate, not production authorization.
No Docker daemon, production data, or deployment is used. TEST_PG_ROOT selects
an isolated PostgreSQL installation with bin, share/pgsql, and lib64.
TEST_PG_BIN, TEST_PG_LIB, and TEST_PG_SHARE can override those paths separately.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

import isolated_pg_supervisor as supervisor
from test_username_migration_docker_pg_backup import FakeDocker, CONTAINER, IMAGE, SOURCE
from username_migration_docker_pg_backup import UnverifiedDockerCapture
from username_migration_docker_pg_restore_check import DisposableRestoreCheck
import username_migration_docker_pg_evidence as evidence
import username_migration_pg_anchor as anchor

ROOT = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr')).resolve()
BIN = Path(os.environ.get('TEST_PG_BIN', ROOT / 'bin')).resolve()
LIB = Path(os.environ.get('TEST_PG_LIB', ROOT / 'lib64')).resolve()
SHARE = Path(os.environ.get('TEST_PG_SHARE', ROOT / 'share/pgsql')).resolve()
spec = importlib.util.spec_from_file_location('migration_journal',
    Path(__file__).resolve().with_name('username-migration-journal.py'))
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)


@unittest.skipUnless((BIN / 'initdb').is_file(), 'isolated PostgreSQL binaries unavailable')
class AnchorIntegration(unittest.TestCase):
    def test_capture_restore_bind_reopen_and_reject_changes(self):
        with tempfile.TemporaryDirectory(prefix='pg-anchor-integration-') as temp:
            root = Path(temp).resolve()
            backup = root / 'backup'
            state = root / 'state'
            other = root / 'other-state'
            for directory in (backup, state, other):
                directory.mkdir(mode=0o700)
            operation = str(uuid.uuid4())
            fd = os.open(backup, os.O_RDONLY | os.O_DIRECTORY)
            params = dict(bindir=str(BIN), share=str(SHARE),
                          library_path=str(LIB), parent=str(root), superuser='app')
            try:
                with supervisor.IsolatedPostgres(**params) as source, supervisor.IsolatedPostgres(**params) as target:
                    def sql(cluster, database, query):
                        return cluster.run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                            '-d', database, '-c', query], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE).stdout.strip()
                    source.run('createdb', ['chat'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    sql(source, 'chat', 'CREATE TABLE marker (value integer); INSERT INTO marker VALUES (42)')
                    source_id = sql(source, 'postgres', 'SELECT system_identifier FROM pg_control_system()').decode()
                    target_id = sql(target, 'postgres', 'SELECT system_identifier FROM pg_control_system()').decode()
                    self.assertNotEqual(source_id, target_id)
                    fake = FakeDocker()
                    for row in fake.rows:
                        row['Config']['Labels']['username-migration.operation'] = operation
                    def capture_runner(args, **kwargs):
                        command = args[3:]
                        if command and command[0] == 'exec':
                            for program in ('psql', 'pg_dump'):
                                if program in command:
                                    return source.run(program, command[command.index(program) + 1:],
                                        input=kwargs.get('input'), stdout=kwargs.get('stdout'), stderr=subprocess.PIPE)
                        return fake(args, **kwargs)
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
                    with journal_module.Journal(str(state)) as journal:
                        journal.begin(operation)
                        journal.advance('fence')
                        journal.advance('backup')
                        UnverifiedDockerCapture(directory_fd=fd, operation=operation, container_id=CONTAINER,
                            image_id=IMAGE, volume='synthetic-volume', volume_destination='/data',
                            stopped_container_ids=[SOURCE], runner=capture_runner, gate=lambda: True
                            ).capture(database='chat', role='app')
                        metadata = json.loads((backup / 'postgres-metadata.json').read_text())
                        digest = hashlib.sha256((backup / 'postgres.dump').read_bytes()).hexdigest()
                        result = DisposableRestoreCheck(directory_fd=fd, expected_sha256=digest,
                            selected_database_properties=metadata['selected_database_properties'],
                            container_id=CONTAINER, runner=restore_runner,
                            expected_source_system_identifier=source_id, gate=lambda: True).check()
                        self.assertEqual(result['target_system_identifier'], target_id)
                        self.assertEqual(result['status'], 'MATCHED')
                        self.assertEqual(sql(target, 'chat', 'SELECT value FROM marker'), b'42')
                        binding = evidence.bind_test_only(journal=journal, directory=str(backup))
                        self.assertEqual(anchor.store_anchor(journal, binding), binding)
                    with journal_module.Journal(str(state)) as journal:
                        saved = anchor.load_anchor(journal)
                        self.assertEqual(saved, binding)
                        def migrate_if_verified():
                            evidence.verify_test_only(journal=journal, directory=str(backup),
                                                      independent_binding_sha256=anchor.load_anchor(journal))
                            journal.advance('migrate')
                        for name in ('postgres.dump', 'postgres-metadata.json',
                                     'postgres-restore-check.json', evidence._BINDING):
                            path = backup / name
                            original = path.read_bytes()
                            for replacement in (None, b'corrupted'):
                                with self.subTest(file=name, replacement=replacement):
                                    if replacement is None:
                                        path.unlink()
                                    else:
                                        path.write_bytes(replacement)
                                    try:
                                        with self.assertRaises(evidence.VerificationError):
                                            migrate_if_verified()
                                        self.assertEqual(journal.load()['phase'], 'backup')
                                    finally:
                                        path.write_bytes(original)
                                        path.chmod(0o600)
                        verified = evidence.verify_test_only(journal=journal, directory=str(backup),
                                                             independent_binding_sha256=saved)
                        self.assertFalse(verified['restore_authorized'])
                        migrate_if_verified()
                        self.assertEqual(journal.load()['phase'], 'migrate')
                    with journal_module.Journal(str(other)) as journal:
                        journal.begin(str(uuid.uuid4()))
                        journal.advance('fence')
                        journal.advance('backup')
                        with self.assertRaises(evidence.VerificationError):
                            evidence.verify_test_only(journal=journal, directory=str(backup),
                                                      independent_binding_sha256=binding)
                        self.assertEqual(journal.load()['phase'], 'backup')
            finally:
                os.close(fd)


if __name__ == '__main__':
    unittest.main()
