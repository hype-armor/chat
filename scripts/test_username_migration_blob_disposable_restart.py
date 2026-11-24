import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from username_migration_blob_tree import inventory
from username_migration_blob_disposable_restart import restore, RestoreError, operational


class DisposableRestoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'file').write_text('snapshot')
        (self.source / 'link').symlink_to('file')
        self.archive = self.root / 'snapshot.tar'
        subprocess.run(['tar', '--create', '--file', str(self.archive), '--acls',
                        '--xattrs', '-C', str(self.source), '.'], check=True)
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.expected = inventory(self.source)
        self.dest = self.root / 'destination'
        self.dest.mkdir()
        (self.dest / 'old').write_text('old')
        self.intent = self.root / 'intent.json'
        self.phases = []

    def run_restore(self, interrupt=None, fence=None):
        restore(self.archive, self.digest, self.expected, self.dest, self.intent,
                fence or self.phases.append, interrupt)

    def test_retry_each_step(self):
        self.assertFalse(operational)
        for step in ('intent', 'remove', 'clear', 'extract'):
            (self.dest / 'extra').write_text('remove on retry')
            def stop(current):
                if current == step:
                    raise RuntimeError('interrupted')
            with self.assertRaises(RuntimeError):
                self.run_restore(stop)
            self.assertTrue(self.intent.exists())
            self.run_restore()
            self.assertEqual(inventory(self.dest), self.expected)

    def test_symlink_clear_does_not_follow(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('safe')
        (self.dest / 'external').symlink_to(outside, target_is_directory=True)
        self.run_restore()
        self.assertEqual((outside / 'keep').read_text(), 'safe')

    def test_bad_digest_or_inventory_does_not_clear(self):
        self.digest = '0' * 64
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.assertTrue((self.dest / 'old').exists())
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.expected = {}
        with self.assertRaises(RestoreError):
            self.run_restore()
        self.assertTrue((self.dest / 'old').exists())

    def test_fence_rejects_and_identity_change_rejects(self):
        def reject(phase):
            if phase == 'clear':
                raise RuntimeError('fence')
        with self.assertRaises(RuntimeError):
            self.run_restore(fence=reject)
        self.assertTrue((self.dest / 'old').exists())
        def replace(phase):
            if phase == 'clear':
                self.dest.rename(self.root / 'original')
                self.dest.mkdir()
        with self.assertRaises(RestoreError):
            self.run_restore(fence=replace)
        self.assertTrue((self.root / 'original' / 'old').exists())

    def test_changed_identity_on_retry(self):
        def stop(step):
            if step == 'intent':
                raise RuntimeError()
        with self.assertRaises(RuntimeError):
            self.run_restore(stop)
        self.dest.rename(self.root / 'original')
        self.dest.mkdir()
        with self.assertRaises(RestoreError):
            self.run_restore()


if __name__ == '__main__':
    unittest.main()
