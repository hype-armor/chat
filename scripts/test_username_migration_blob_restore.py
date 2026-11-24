import hashlib
import io
import os
import tarfile
import tempfile
import unittest

import username_migration_blob_archive as archive
import username_migration_blob_restore as restore
from username_migration_blob_tree import inventory


class RestorePreflightTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = os.path.join(self.tmp.name, 'source')
        self.workspace = os.path.join(self.tmp.name, 'workspace')
        os.mkdir(self.source, 0o700)
        os.mkdir(self.workspace, 0o700)
        with open(os.path.join(self.source, 'file'), 'wb') as f:
            f.write(b'synthetic data')
        self.backup = archive.capture(self.source, self.workspace, 'archive.tar')

    def digest(self):
        with open(self.backup, 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()

    def test_real_archive_is_sealed(self):
        fd = restore.snapshot_and_validate(self.backup, self.digest())
        try:
            with self.assertRaises(OSError):
                os.write(fd, b'changed')
        finally:
            os.close(fd)

    def test_wrong_digest_and_corruption(self):
        digest = self.digest()
        with self.assertRaises(restore.RestoreError):
            restore.snapshot_and_validate(self.backup, '0' * 64)
        with open(self.backup, 'r+b') as f:
            f.write(b'corrupted')
        with self.assertRaises(restore.RestoreError):
            restore.snapshot_and_validate(self.backup, digest)

    def test_traversal_rejected_even_with_matching_digest(self):
        with tarfile.open(self.backup, 'w') as tar:
            root = tarfile.TarInfo('.')
            root.type = tarfile.DIRTYPE
            tar.addfile(root)
            item = tarfile.TarInfo('../outside')
            item.size = 1
            tar.addfile(item, io.BytesIO(b'x'))
        with self.assertRaises(restore.RestoreError):
            restore.snapshot_and_validate(self.backup, self.digest())

    def test_disposable_restore_compares_tree_and_cleans_failures(self):
        expected = inventory(self.source)
        restored = restore._restore_disposable_test_only(archive_path=self.backup,
            trusted_sha256=self.digest(), expected_inventory=expected, workspace=self.workspace)
        self.assertEqual(inventory(restored), expected)
        before = set(os.listdir(self.workspace))
        with self.assertRaises(restore.RestoreError):
            restore._restore_disposable_test_only(archive_path=self.backup,
                trusted_sha256=self.digest(), expected_inventory={'entries': []}, workspace=self.workspace)
        self.assertEqual(set(os.listdir(self.workspace)), before)
        with self.assertRaises(restore.RestoreError):
            restore._restore_disposable_test_only(archive_path=self.backup,
                trusted_sha256='0' * 64, expected_inventory=expected, workspace=self.workspace)
        self.assertEqual(set(os.listdir(self.workspace)), before)

    def test_restore_is_always_disabled(self):
        with self.assertRaises(restore.RestoreError):
            restore.restore(self.backup, self.workspace)
        self.assertEqual(os.listdir(self.workspace), ['archive.tar'])


if __name__ == '__main__':
    unittest.main()
