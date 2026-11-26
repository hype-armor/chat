#!/usr/bin/env python3
"""Mock-only checks for the disabled isolated PostgreSQL rotation adapter."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

path = Path(__file__).with_name('isolated_pg_rotation.py')
spec = importlib.util.spec_from_file_location('isolated_pg_rotation', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
IMAGE = 'sha256:' + 'a' * 64
CID = 'b' * 64
SECRET = 'c' * 64
OP = 'd' * 32
NAME = 'chat-pg-fence-' + OP


class Docker:
    def __init__(self):
        self.calls = []
        self.active = ''
        self.checks = {'extra_logins': 0, 'prepared': 0, 'bad_hba': 0, 'extra_replication': 0, 'preload': '', 'superuser': True, 'user': 'chat', 'port': '5432'}
        self.network = 'none'
        self.fail_remove = False
        self.fail_change = False
        self.exists = False
        self.label = OP
        self.create_error = None

    def __call__(self, args, *, input=None):
        self.calls.append((args, input))
        if args[1:3] == ['ps', '--filter']:
            return self.active
        if args[1:3] == ['ps', '-a']:
            return NAME if self.exists else ''
        if args[1] == 'create':
            self.exists = True
            if self.create_error:
                raise self.create_error
            return CID
        if args[1:3] == ['inspect', NAME]:
            return json.dumps([{'Id': CID, 'Name': '/' + NAME, 'Config': {'Labels': {'chat.rotation.operation': self.label}}, 'Image': IMAGE, 'HostConfig': {'NetworkMode': self.network}, 'Mounts': [{'Type': 'volume', 'Name': 'chat_postgres', 'Destination': '/var/lib/postgresql'}]}])
        if args[1] == 'exec' and 'psql' in args:
            if input.startswith('SELECT'):
                return json.dumps(self.checks)
            if self.fail_change:
                raise subprocess.CalledProcessError(1, args)
        if args[1:3] == ['rm', '-f']:
            if self.fail_remove:
                raise subprocess.CalledProcessError(1, args)
            self.exists = False
        return ''


class RotationTests(unittest.TestCase):
    def setUp(self):
        self.docker = Docker()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = str(Path(self.tmp.name) / 'journal')

    def rotate(self):
        return module.rotate_isolated(IMAGE, 'chat_postgres', 'chat', SECRET, operation_id=OP, journal_path=self.journal, run=self.docker, sleep=lambda _: None)

    def test_isolated_rotation_and_cleanup(self):
        self.rotate()
        create = next(args for args, _ in self.docker.calls if args[1] == 'create')
        self.assertIn('none', create)
        self.assertIn(IMAGE, create)
        self.assertIn('listen_addresses=', create)
        self.assertIn('shared_preload_libraries=', create)
        self.assertFalse(any(SECRET in ' '.join(args) for args, _ in self.docker.calls))
        change = next(body for args, body in self.docker.calls if body and body.startswith('SET'))
        self.assertIn(SECRET, change)
        self.assertIn('log_statement', change)
        self.assertEqual(self.docker.calls[-1][0], ['docker', 'rm', '-f', CID])
        self.assertNotIn('-v', self.docker.calls[-1][0])

    def test_rejects_active_volume(self):
        self.docker.active = 'other'
        with self.assertRaises(module.RotationError): self.rotate()
        self.assertFalse(any(args[1] == 'create' for args, _ in self.docker.calls))

    def test_rejects_wrong_network_before_start(self):
        self.docker.network = 'bridge'
        with self.assertRaises(module.RotationError): self.rotate()
        self.assertFalse(any(args[1] == 'start' for args, _ in self.docker.calls))
        self.assertFalse(any(args[1] == 'rm' for args, _ in self.docker.calls))

    def test_rejects_untrusted_auth_roles_and_prepared_transactions(self):
        for key, value in [('extra_logins', 1), ('prepared', 1), ('bad_hba', 1), ('extra_replication', 1), ('preload', 'extension'), ('superuser', False), ('user', 'other')]:
            with self.subTest(key=key):
                self.docker = Docker()
                self.docker.checks[key] = value
                with self.assertRaises(module.RotationError): self.rotate()
                self.assertFalse(any(body and body.startswith('SET') for _, body in self.docker.calls))
                self.assertEqual(self.docker.calls[-1][0], ['docker', 'rm', '-f', CID])

    def test_failed_rotation_or_cleanup_fails(self):
        self.docker.fail_change = True
        with self.assertRaises(module.RotationError): self.rotate()
        self.assertEqual(self.docker.calls[-1][0], ['docker', 'rm', '-f', CID])
        self.docker = Docker()
        self.docker.fail_remove = True
        with self.assertRaisesRegex(module.RotationError, 'cleanup failed'): self.rotate()

    def test_lost_create_response_and_timeout_clean_up(self):
        for error in (subprocess.CalledProcessError(1, ['docker']), subprocess.TimeoutExpired('docker', 1)):
            with self.subTest(error=type(error)):
                self.docker = Docker()
                self.docker.create_error = error
                with self.assertRaises(module.RotationError): self.rotate()
                self.assertFalse(self.docker.exists)
                self.assertTrue(Path(self.journal).exists())
                self.assertIn((['docker', 'rm', '-f', CID], None), self.docker.calls)

    def test_collision_fails_closed(self):
        self.docker.exists = True
        self.docker.label = 'other'
        with self.assertRaisesRegex(module.RotationError, 'cleanup failed'): self.rotate()
        self.assertFalse(any(args[1] in ('create', 'rm') for args, _ in self.docker.calls))

    def test_rerun_recovers_verified_container(self):
        self.docker.exists = True
        self.rotate()
        actions = [args[1] for args, _ in self.docker.calls]
        self.assertLess(actions.index('rm'), actions.index('create'))
        self.assertFalse(self.docker.exists)

    def test_retry_must_keep_role_and_credential(self):
        self.rotate()
        before = len(self.docker.calls)
        for role, password in [('other', SECRET), ('chat', 'f' * 64)]:
            with self.subTest(role=role):
                with self.assertRaises(module.RotationError):
                    module.rotate_isolated(IMAGE, 'chat_postgres', role, password, operation_id=OP, journal_path=self.journal, run=self.docker)
        self.assertEqual(len(self.docker.calls), before)

    def test_journal_uses_unique_salts_and_preserves_existing_retry_bytes(self):
        self.rotate()
        first = Path(self.journal).read_bytes()
        self.rotate()
        self.assertEqual(Path(self.journal).read_bytes(), first)
        second = Path(self.tmp.name) / 'second'
        module.rotate_isolated(IMAGE, 'chat_postgres', 'chat', SECRET, operation_id=OP,
                               journal_path=second, run=self.docker)
        verifier = json.loads(first)['credential_verifier']
        other = json.loads(second.read_bytes())['credential_verifier']
        self.assertEqual(verifier['scheme'], 'scrypt-v1')
        self.assertNotEqual(verifier['salt'], other['salt'])
        self.assertNotEqual(verifier['digest'], other['digest'])
        self.assertNotIn(SECRET.encode(), first)

    def test_legacy_and_invalid_verifiers_fail_closed_without_rewriting_journal(self):
        self.rotate()
        journal = Path(self.journal)
        original = json.loads(journal.read_bytes())
        legacy = dict(original)
        del legacy['credential_verifier']
        legacy['credential_hash'] = '0' * 64
        candidates = [legacy]
        for key, value in [('scheme', 'scrypt-v2'), ('salt', 'wrong'), ('digest', '0' * 64)]:
            candidates.append({**original, 'credential_verifier': {**original['credential_verifier'], key: value}})
        before = len(self.docker.calls)
        for record in candidates:
            with self.subTest(record=record):
                body = json.dumps(record).encode()
                journal.write_bytes(body)
                with self.assertRaisesRegex(module.RotationError, 'journal unavailable or mismatched'):
                    self.rotate()
                self.assertEqual(journal.read_bytes(), body)
        self.assertEqual(len(self.docker.calls), before)

    def test_invalid_values_never_invoke_docker(self):
        for image, volume, role, password in [('latest', 'chat_postgres', 'chat', SECRET), (IMAGE, 'bad/name', 'chat', SECRET), (IMAGE, 'chat_postgres', 'x;drop', SECRET), (IMAGE, 'chat_postgres', 'chat', 'password')]:
            with self.subTest(image=image, volume=volume, role=role):
                with self.assertRaises(module.RotationError):
                    module.rotate_isolated(image, volume, role, password, operation_id=OP, journal_path=self.journal, run=self.docker)
        self.assertEqual(self.docker.calls, [])


if __name__ == '__main__':
    unittest.main()
