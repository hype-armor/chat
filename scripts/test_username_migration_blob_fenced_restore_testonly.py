import copy
import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path

from username_migration_blob_tree import inventory
from username_migration_blob_disposable_restart import RestoreError
from username_migration_blob_fenced_restore_testonly import operational, restore_testonly


class FencedRestoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.volumes = root / 'volumes'
        self.volumes.mkdir()
        self.dest = self.volumes / 'blob'
        self.dest.mkdir()
        (self.dest / 'old').write_text('old')
        self.source = root / 'source'
        self.source.mkdir()
        (self.source / 'new').write_text('new')
        self.workspace = root / 'workspace'
        self.workspace.mkdir()
        self.archive = self.workspace / 'snapshot.tar'
        subprocess.run(['tar', '--create', '--file', str(self.archive), '--acls', '--xattrs',
                        '-C', str(self.source), '.'], check=True)
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.data = {'volume': {'Name': 'blob', 'Driver': 'local', 'Mountpoint': str(self.dest), 'Options': {}},
                     'containers': [{'Id': 'a' * 64, 'State': 'exited',
                                     'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
                                     'Mounts': [{'Type': 'volume', 'Name': 'blob', 'Source': str(self.dest)}]}]}
        self.phases = []

    def run_restore(self, interrupt=None, journal=None, **kwargs):
        args = dict(synthetic_volume_root=self.volumes, volume_name='blob', source=self.source,
                    workspace=self.workspace, snapshot=self.archive, snapshot_sha256=self.digest,
                    expected_inventory=inventory(self.source), intent_path=self.workspace / 'intent',
                    inspect_fake_docker=lambda: copy.deepcopy(self.data),
                    verify_rollback_journal=journal or (lambda phase, name, identity: self.phases.append(phase) or True),
                    interrupt=interrupt)
        args.update(kwargs)
        return restore_testonly(**args)

    def test_resume_after_each_injected_failure(self):
        self.assertFalse(operational)
        for step in ('intent', 'remove', 'clear', 'extract'):
            (self.dest / 'extra').write_text('x')
            def stop(current):
                if current == step:
                    raise RuntimeError('injected')
            with self.assertRaises(RuntimeError):
                self.run_restore(interrupt=stop)
            self.run_restore()
            self.assertEqual(inventory(self.dest), inventory(self.source))
        self.assertTrue({'validate', 'intent', 'clear', 'extract', 'verify', 'complete'}.issubset(self.phases))

    def test_rejects_active_and_restart_consumers(self):
        container = self.data['containers'][0]
        for state in ('running', 'paused', 'restarting', 'removing'):
            container['State'] = state
            with self.assertRaises(RestoreError):
                self.run_restore()
        container['State'] = 'exited'
        for policy in ('always', 'unless-stopped', 'on-failure'):
            container['RestartPolicy']['Name'] = policy
            with self.assertRaises(RestoreError):
                self.run_restore()
        self.assertTrue((self.dest / 'old').exists())

    def test_bind_alias_and_malformed_inspection(self):
        alias = self.source.parent / 'alias'
        alias.symlink_to(self.dest, target_is_directory=True)
        self.data['containers'][0]['Mounts'].append({'Type': 'bind', 'Name': '', 'Source': str(alias)})
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.data['containers'][0]['Mounts'].pop()
        self.data['volume']['Options'] = {'device': '/other'}
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.assertTrue((self.dest / 'old').exists())

    def test_journal_and_identity_gate(self):
        def journal(phase, name, identity):
            if phase == 'clear':
                return False
            return True
        with self.assertRaises(RestoreError):
            self.run_restore(journal=journal)
        self.assertTrue((self.dest / 'old').exists())
        def replace(phase, name, identity):
            if phase == 'clear':
                self.dest.rename(self.volumes / 'original')
                self.dest.mkdir()
            return True
        with self.assertRaises(RestoreError):
            self.run_restore(journal=replace)
        self.assertTrue((self.volumes / 'original' / 'old').exists())

    def test_source_workspace_overlap_rejected(self):
        with self.assertRaises(RestoreError):
            self.run_restore(source=self.workspace)
        self.assertTrue((self.dest / 'old').exists())


if __name__ == '__main__':
    unittest.main()
