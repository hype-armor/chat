import os
import shutil
import socket
import tempfile
import unittest
from unittest import mock

import username_migration_blob_tree as tree


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = os.path.join(self.tmp.name, 'source')
        self.dst = os.path.join(self.tmp.name, 'restored')
        os.mkdir(self.src)
        with open(os.path.join(self.src, 'file'), 'wb') as f:
            f.write(b'content')
        os.link(os.path.join(self.src, 'file'), os.path.join(self.src, 'hard'))
        os.symlink('file', os.path.join(self.src, 'link'))
        os.mkdir(os.path.join(self.src, 'dir'))
        shutil.copytree(self.src, self.dst, symlinks=True, copy_function=shutil.copy2)
        os.unlink(os.path.join(self.dst, 'hard'))
        os.link(os.path.join(self.dst, 'file'), os.path.join(self.dst, 'hard'))
        shutil.copystat(self.src, self.dst)

    def matches(self):
        return tree.inventory(self.src) == tree.inventory(self.dst)

    def test_equal_and_hardlinks(self):
        self.assertTrue(self.matches())
        self.assertEqual(len(tree.inventory(self.src)['hardlinks']), 1)
        path = os.path.join(self.dst, 'hard')
        os.unlink(path)
        shutil.copy2(os.path.join(self.dst, 'file'), path)
        shutil.copystat(self.src, self.dst)
        self.assertFalse(self.matches())

    def test_extra_and_missing(self):
        os.unlink(os.path.join(self.dst, 'file'))
        self.assertFalse(self.matches())
        with open(os.path.join(self.dst, 'extra'), 'wb') as f:
            f.write(b'x')
        self.assertFalse(self.matches())

    def test_mode_and_content(self):
        path = os.path.join(self.dst, 'file')
        os.chmod(path, 0o600 if os.stat(path).st_mode & 0o777 != 0o600 else 0o644)
        self.assertFalse(self.matches())
        shutil.copystat(os.path.join(self.src, 'file'), path)
        with open(path, 'wb') as f:
            f.write(b'changed')
        shutil.copystat(os.path.join(self.src, 'file'), path)
        self.assertFalse(self.matches())

    def test_symlink_target(self):
        path = os.path.join(self.dst, 'link')
        os.unlink(path)
        os.symlink('else', path)
        self.assertFalse(self.matches())

    def test_xattr(self):
        path = os.path.join(self.src, 'file')
        try:
            os.setxattr(path, b'user.blob_test', b'value')
        except OSError as exc:
            self.skipTest('user xattrs unavailable: ' + str(exc))
        self.assertFalse(self.matches())
        os.setxattr(os.path.join(self.dst, 'file'), b'user.blob_test', b'value')
        self.assertTrue(self.matches())

    def test_unreadable_xattr_rejected(self):
        with mock.patch.object(tree.os, 'listxattr', side_effect=PermissionError('denied')):
            with self.assertRaises(tree.TreeError):
                tree.inventory(self.src)

    def test_special_file_rejected(self):
        os.mkfifo(os.path.join(self.src, 'fifo'))
        with self.assertRaises(tree.TreeError):
            tree.inventory(self.src)
        os.unlink(os.path.join(self.src, 'fifo'))
        with socket.socket(socket.AF_UNIX) as sock:
            sock.bind(os.path.join(self.src, 'socket'))
            with self.assertRaises(tree.TreeError):
                tree.inventory(self.src)

    def test_root_symlink_rejected(self):
        path = os.path.join(self.tmp.name, 'rootlink')
        os.symlink(self.src, path)
        with self.assertRaises(tree.TreeError):
            tree.inventory(path)

    def test_stat_change_rejected(self):
        original = tree.signature
        calls = 0
        def changed(st):
            nonlocal calls
            calls += 1
            result = original(st)
            return result + (calls,)
        with mock.patch.object(tree, 'signature', side_effect=changed):
            with self.assertRaises(tree.TreeError):
                tree.inventory(self.src)


if __name__ == '__main__':
    unittest.main()
