import ctypes
import errno
import os
import struct
import tempfile
import unittest
from unittest import mock

import username_migration_mount_check_testonly as check


class MountCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.root)
        os.mkdir('dir', dir_fd=self.root)
        with open(os.path.join(self.tmp.name, 'dir', 'file'), 'w') as out:
            out.write('synthetic')

    def run_check(self, **overrides):
        options = dict(max_entries=2, max_depth=2, max_path_bytes=8,
                       fence=lambda: True)
        options.update(overrides)
        check.check_tree(self.root, **options)

    def test_same_ids(self):
        with mock.patch.object(check, 'mount_id', return_value=7):
            self.run_check()

    def test_distinct_ids_same_device(self):
        def ids(fd):
            return 8 if os.fstat(fd).st_ino == os.stat('dir', dir_fd=self.root).st_ino else 7
        with mock.patch.object(check, 'mount_id', side_effect=ids):
            with self.assertRaisesRegex(check.UnsafeTree, 'mount boundary'):
                self.run_check()

    def test_symlink_rejected(self):
        os.symlink('dir', 'link', dir_fd=self.root)
        with mock.patch.object(check, 'mount_id', return_value=7):
            with self.assertRaisesRegex(check.UnsafeTree, 'symlink'):
                self.run_check(max_entries=3, max_path_bytes=8)

    def test_identity_drift(self):
        original = check._identity
        calls = 0
        def drift(info):
            nonlocal calls
            calls += 1
            result = original(info)
            return (result[0], result[1] + (1 if calls == 4 else 0), result[2])
        with mock.patch.object(check, 'mount_id', return_value=7), mock.patch.object(check, '_identity', side_effect=drift):
            with self.assertRaisesRegex(check.UnsafeTree, 'identity drift'):
                self.run_check()

    def test_mount_error_fails_closed(self):
        with mock.patch.object(check, 'mount_id', side_effect=OSError(errno.EACCES, 'denied')):
            with self.assertRaises(OSError):
                self.run_check()

    def test_real_statx_on_temporary_tree(self):
        try:
            self.run_check()
        except check.Unsupported as exc:
            self.skipTest(str(exc))

    def test_explicit_limits_and_callback_required(self):
        with self.assertRaises(TypeError):
            check.check_tree(self.root)
        for value in (-1, True, float('inf'), 1.5, None):
            for key in ('max_entries', 'max_depth', 'max_path_bytes'):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    self.run_check(**{key: value})
        with self.assertRaises(ValueError):
            self.run_check(fence=None)

    def test_limits(self):
        with mock.patch.object(check, 'mount_id', return_value=7):
            self.run_check()
            for key, value, message in (
                ('max_entries', 1, 'entry limit'),
                ('max_depth', 1, 'path depth'),
                ('max_path_bytes', 7, 'path byte'),
            ):
                with self.subTest(key=key), self.assertRaisesRegex(check.UnsafeTree, message):
                    self.run_check(**{key: value})

    def test_fence_change_and_error_fail_closed(self):
        with mock.patch.object(check, 'mount_id', return_value=7):
            for result in (False, None, 1):
                callback = mock.Mock(side_effect=[True, True, result])
                with self.subTest(result=result), self.assertRaisesRegex(check.UnsafeTree, 'fence'):
                    self.run_check(fence=callback)
            callback = mock.Mock(side_effect=[True, RuntimeError('lost')])
            with self.assertRaisesRegex(check.UnsafeTree, 'fence'):
                self.run_check(fence=callback)

    def test_scandir_is_used_instead_of_listdir(self):
        with mock.patch.object(check, 'mount_id', return_value=7), \
             mock.patch.object(check.os, 'listdir', side_effect=AssertionError('unbounded')):
            self.run_check()


class StatxTests(unittest.TestCase):
    def call_with(self, function):
        libc = mock.Mock()
        libc.statx = mock.Mock(side_effect=function)
        with mock.patch.object(check.ctypes, 'CDLL', return_value=libc):
            return check.mount_id(3)

    def test_returned_mount_id(self):
        def statx(fd, path, flags, mask, buffer):
            self.assertEqual((fd, path, flags, mask), (3, b'', check.AT_EMPTY_PATH, check.STATX_MNT_ID))
            struct.pack_into('=I', buffer, 0, check.STATX_MNT_ID)
            struct.pack_into('=Q', buffer, 144, 123456)
            return 0
        self.assertEqual(self.call_with(statx), 123456)

    def test_missing_mask(self):
        with self.assertRaises(check.Unsupported):
            self.call_with(lambda *args: 0)

    def test_syscall_errors(self):
        for code, expected in [(errno.ENOSYS, check.Unsupported), (errno.EINVAL, check.Unsupported),
                               (errno.EOPNOTSUPP, check.Unsupported), (errno.EACCES, OSError)]:
            def fail(*args):
                ctypes.set_errno(code)
                return -1
            with self.subTest(code=code), self.assertRaises(expected):
                self.call_with(fail)

    def test_missing_libc_symbol(self):
        with mock.patch.object(check.ctypes, 'CDLL', return_value=object()):
            with self.assertRaises(check.Unsupported):
                check.mount_id(3)

    def test_non_linux(self):
        with mock.patch.object(check.sys, 'platform', 'other'):
            with self.assertRaises(check.Unsupported):
                check.mount_id(3)


if __name__ == '__main__':
    unittest.main()
