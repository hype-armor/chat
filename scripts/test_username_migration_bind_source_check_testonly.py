import copy
import os
import shutil
import tempfile
import unittest
from unittest import mock

import username_migration_bind_source_check_testonly as check
from username_migration_blob_tree import inventory
from username_migration_compose_binds import BindPolicyError, _copy_file


class SourceCheckTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.snapshots = os.path.join(self.root, 'snapshots')
        os.mkdir(self.snapshots, 0o700)
        self.source = os.path.join(self.root, 'source')
        with open(self.source, 'wb') as stream:
            stream.write(b'fixture')
        self.snapshot = os.path.join(self.snapshots, 'bind_0')
        content = _copy_file(self.source, self.snapshot)
        info = os.stat(self.source)
        self.records = [{'service': 'web', 'index': 0, 'source': self.source,
                         'source_identity': {'device': info.st_dev, 'inode': info.st_ino},
                         'snapshot': self.snapshot, 'content': content}]

    def verify(self):
        return check.verify_sources(self.records, self.snapshots)

    def test_file_and_mutations(self):
        self.assertTrue(self.verify())
        with open(self.source, 'wb') as stream:
            stream.write(b'changed')
        with self.assertRaises(BindPolicyError):
            self.verify()

    def test_metadata_and_identity(self):
        os.chmod(self.source, 0o600 if os.stat(self.source).st_mode & 0o777 != 0o600 else 0o644)
        with self.assertRaises(BindPolicyError):
            self.verify()
        os.rename(self.source, self.source + '.old')
        shutil.copy2(self.snapshot, self.source)
        with self.assertRaises(BindPolicyError):
            self.verify()

    def test_forged_or_missing_records(self):
        self.records[0]['source_identity']['inode'] += 1
        with self.assertRaises(BindPolicyError):
            self.verify()
        self.records[0]['source_identity']['inode'] -= 1
        self.records.append(copy.deepcopy(self.records[0]))
        with self.assertRaises(BindPolicyError):
            self.verify()
        self.records.pop()
        os.unlink(self.source)
        with self.assertRaises(BindPolicyError):
            self.verify()

    def test_changed_snapshot(self):
        with open(self.snapshot, 'wb') as stream:
            stream.write(b'forged')
        with self.assertRaises(BindPolicyError):
            self.verify()

    def test_directory(self):
        os.unlink(self.source)
        os.unlink(self.snapshot)
        os.mkdir(self.source)
        with open(os.path.join(self.source, 'data'), 'wb') as stream:
            stream.write(b'fixture')
        shutil.copytree(self.source, self.snapshot, copy_function=shutil.copy2)
        info = os.stat(self.source)
        self.records[0]['source_identity'] = {'device': info.st_dev, 'inode': info.st_ino}
        self.records[0]['content'] = {'type': 'directory', 'inventory': inventory(self.source)}
        self.assertTrue(self.verify())
        os.link(os.path.join(self.source, 'data'), os.path.join(self.root, 'outside'))
        with self.assertRaises(BindPolicyError):
            self.verify()

    def test_path_replaced_during_read(self):
        original = check._open_without_symlinks
        calls = 0
        def replace(path):
            nonlocal calls
            if path == self.source:
                calls += 1
                if calls == 2:
                    os.rename(self.source, self.source + '.old')
                    shutil.copy2(self.snapshot, self.source)
            return original(path)
        with mock.patch.object(check, '_open_without_symlinks', side_effect=replace):
            with self.assertRaises(BindPolicyError):
                self.verify()


if __name__ == '__main__':
    unittest.main()
