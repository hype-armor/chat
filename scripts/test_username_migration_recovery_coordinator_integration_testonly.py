"""Synthetic coordinator integration only. No Docker daemon or deployment.

The fence and runtime are fixtures. Evidence digests do not prove provenance,
isolation, or restore authorization. The operational preflight stays disabled.
"""
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import tempfile
import unittest
import uuid

import username_migration_blob_archive as blobs
import username_migration_blob_restore as blob_restore
import username_migration_docker_pg_evidence as pg
import username_migration_pg_anchor as pg_anchor
import username_migration_recovery_anchor_testonly as recovery
import storage_quiescence_policy_testonly as policy

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('components', HERE / 'username-migration-orchestrator-components.py')
components = importlib.util.module_from_spec(spec)
spec.loader.exec_module(components)


class SyntheticCoordinator(components.Orchestrator):
    def _preflight(self):
        pass  # Only this test subclass bypasses the operational guard.


class Integration(unittest.TestCase):
    def exercise(self, change=None, when=None, post_commit=False, policy_change=None):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ('journal', 'evidence', 'source'):
                (root / name).mkdir(mode=0o700)
            evidence = root / 'evidence'
            (root / 'source' / 'blob').write_bytes(b'synthetic blob')
            runtime = evidence / 'runtime.json'
            runtime.write_bytes(b'synthetic runtime')
            runtime.chmod(0o600)
            props = {'name': 'chat', 'owner': 'app', 'encoding': 'UTF8', 'collate': 'C', 'ctype': 'C',
                     'connection_limit': -1, 'comment': None, 'acl': [], 'settings': []}
            metadata = {'system_id': '12345', 'role': {'rolname': 'app', 'rolsuper': True,
                'rolpassword': None, 'rolinherit': True, 'rolcreatedb': True, 'rolcreaterole': True,
                'rolcanlogin': True, 'rolreplication': False, 'rolbypassrls': False,
                'rolconnlimit': -1, 'rolvaliduntil': None, 'settings': {}},
                'database': {'datname': 'chat', 'owner': 'app', 'encoding': 'UTF8', 'datcollate': 'C',
                             'datctype': 'C', 'datconnlimit': -1, 'datallowconn': True},
                'selected_database_properties': props, 'roles': ['app'], 'databases': ['chat'],
                'prepared': 0, 'memberships': 0}
            validation = {'version': 2, 'source_system_identifier': '12345', 'target_system_identifier': '67890',
                'status': 'MATCHED', 'operational': False, 'restore_authorized': False, 'container_id': 'a' * 64,
                'archive_sha256': hashlib.sha256(b'synthetic pg dump').hexdigest(),
                'selected_database_properties': props}
            for name, data in (('postgres.dump', b'synthetic pg dump'),
                               ('postgres-metadata.json', json.dumps(metadata).encode()),
                               ('postgres-restore-check.json', json.dumps(validation).encode())):
                (evidence / name).write_bytes(data)
                (evidence / name).chmod(0o600)
            events = []
            class Backend:
                token = 'synthetic-fence'
                policy_fault = None
                def check_policy(self):
                    events.append('policy_check')
                    before = self.boundary()
                    counts = {'storage_reserved': 0, 'storage_writing': 0,
                              'storage_ready': 0, 'storage_live': 1, 'uploads': 0,
                              'uploads_retiring': 0, 'completion_claims': 0,
                              'transfers_uploading': 0, 'transfers_complete': 0,
                              'transfers_expired': 0}
                    db = [{'authenticated': True, 'fence': 'synthetic-fence',
                           'cursor': None, 'next_cursor': None,
                           'entries': [{'object_key': 'key', 'state': 'live', 'size_bytes': 4}]}]
                    objects = [{'authenticated': True, 'fence': 'synthetic-fence',
                                'cursor': None, 'next_cursor': None,
                                'entries': [{'key': 'key', 'size': 4}]}]
                    fault = self.policy_fault
                    if fault in ('storage_reserved', 'storage_writing', 'storage_ready',
                                 'transfers_uploading', 'uploads', 'uploads_retiring', 'completion_claims'):
                        counts[fault] = 1
                    elif fault == 'missing':
                        objects[0]['entries'] = []
                    elif fault == 'orphan':
                        objects[0]['entries'].append({'key': 'orphan', 'size': 4})
                    elif fault == 'size':
                        objects[0]['entries'][0]['size'] = 5
                    elif fault == 'fence':
                        self.token = 'changed-fence'
                    policy.check(counts, 'synthetic-fence', db, objects, before, self.boundary())
                    events.append('policy_clean')
                def capture(self): events.append('capture')
                def fence(self): events.append('fence')
                def boundary(self): return self.token
                def backup(self):
                    events.append('backup')
                    self.binding = pg.bind_test_only(journal=self.journal, directory=str(evidence))
                    pg_anchor.store_anchor(self.journal, self.binding)
                    self.archive = Path(blobs.capture(root / 'source', evidence, 'blob.tar'))
                    self.blob_digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
                    recovery.store_anchor(self.journal, **self.args())
                    if when == 'before_migrate':
                        if policy_change: self.policy_fault = policy_change
                        else: self.mutate()
                def verify_pg(self):
                    binding = pg_anchor.load_anchor(self.journal)
                    result = pg.verify_test_only(journal=self.journal, directory=str(evidence),
                                                 independent_binding_sha256=binding)
                    assert result['restore_authorized'] is False
                    return binding
                def verify_blob(self):
                    import os
                    fd = blob_restore.snapshot_and_validate(str(self.archive), self.blob_digest)
                    os.close(fd)
                    return hashlib.sha256(self.archive.read_bytes()).hexdigest()
                def args(self):
                    return dict(boundary=self.boundary, verify_postgres=self.verify_pg,
                                verify_blob=self.verify_blob,
                                verify_runtime=lambda: {'runtime': hashlib.sha256(runtime.read_bytes()).hexdigest()})
                def mutate(self):
                    if change == 'fence':
                        # Simulate loss during one collection, not a new stable fence.
                        self.boundary = lambda: next(self.tokens)
                        self.tokens = itertools.cycle(['synthetic-fence', 'changed-fence'])
                    elif change == 'stable_fence':
                        self.token = 'replacement-fence'
                    else:
                        self.path = {'postgres': evidence / 'postgres.dump', 'blob': self.archive,
                                     'runtime': runtime}[change]
                        self.original = self.path.read_bytes()
                        self.path.write_bytes(b'corrupt')
                def repair(self):
                    if change == 'fence':
                        del self.boundary
                    elif change == 'stable_fence':
                        self.token = 'synthetic-fence'
                    else:
                        self.path.write_bytes(self.original)
                def verify_recovery_set(self):
                    events.append('verify')
                    self.check_policy()
                    recovery.verify_anchor(self.journal, **self.args())
                def migrate(self): events.append('migrate')
                def start_new(self):
                    events.append('start_new')
                    if when == 'before_commit':
                        if policy_change: self.policy_fault = policy_change
                        else: self.mutate()
                def open_new(self):
                    events.append('open_new')
                    if post_commit:
                        self.policy_fault = 'storage_writing'
                        raise RuntimeError('post-commit failure')
                def verify_and_restore(self):
                    events.append('restore_attempt')
                    self.check_policy()
                    recovery.verify_anchor(self.journal, **self.args())
                    events.append('restore')  # Simulated restore; no live resources.
                def restore_old_runtime(self): events.append('restore_runtime')
                def start_old_and_check(self): events.append('start_old')
                def open_old(self): events.append('open_old')
            backend = Backend()
            with components._journal.Journal(root / 'journal') as journal:
                backend.journal = journal
                coordinator = SyntheticCoordinator(journal, backend)
                if change or policy_change or post_commit:
                    with self.assertRaises(Exception): coordinator.run(str(uuid.uuid4()))
                else:
                    coordinator.run(str(uuid.uuid4()))
                if (change or policy_change) and when == 'before_migrate':
                    # Automatic release is unsupported without trusted authority.
                    self.assertEqual(journal.load()['phase'], 'old_ready')
                    self.assertNotIn('migrate', events)
                    self.assertNotIn('restore_attempt', events)
                    self.assertNotIn('open_new', events)
                elif change or policy_change:
                    self.assertEqual(journal.load()['phase'], 'rollback')
                    self.assertTrue(journal.load()['restore_required'])
                    self.assertNotIn('open_new', events)
                    self.assertNotIn('restore', events)
                    if policy_change:
                        backend.policy_fault = None
                        backend.token = 'synthetic-fence'
                    else:
                        backend.repair()
                    # The synthetic open_old is not release authority. The journal
                    # rejects completion, and that error must reach the caller.
                    with self.assertRaises(components._journal.JournalError):
                        coordinator.recover()
                    self.assertEqual(journal.load()['phase'], 'old_ready')
                    self.assertEqual(events.count('restore'), 1)
                    with self.assertRaises(components._journal.JournalError):
                        coordinator.recover()
                    self.assertEqual(events.count('restore'), 1)
                elif post_commit:
                    self.assertEqual(journal.load()['phase'], 'committed')
                    checks = events.count('policy_check')
                    coordinator.recover()
                    self.assertEqual(events.count('policy_check'), checks)
                    self.assertNotIn('restore_attempt', events)
                    self.assertNotIn('start_old', events)
                else:
                    self.assertEqual(journal.load()['phase'], 'complete')
                    self.assertEqual(events.count('verify'), 2)
                    self.assertEqual(events.count('policy_clean'), 2)
                    self.assertLess(events.index('verify'), events.index('migrate'))
                    self.assertLess(len(events) - 1 - events[::-1].index('verify'), events.index('open_new'))

    def test_complete_anchor_at_both_boundaries(self):
        self.exercise()

    def test_component_mutations_fail_closed(self):
        for change in ('postgres', 'blob', 'runtime', 'fence', 'stable_fence'):
            for when in ('before_migrate', 'before_commit'):
                with self.subTest(change=change, when=when):
                    self.exercise(change, when)

    def test_policy_faults_block_both_boundaries(self):
        for fault in ('storage_reserved', 'storage_writing', 'storage_ready',
                      'transfers_uploading', 'uploads', 'uploads_retiring',
                      'completion_claims', 'missing', 'orphan', 'size', 'fence'):
            for when in ('before_migrate', 'before_commit'):
                with self.subTest(fault=fault, when=when):
                    self.exercise(policy_change=fault, when=when)

    def test_post_commit_failure_never_restores(self):
        self.exercise(post_commit=True)


if __name__ == '__main__':
    unittest.main()
