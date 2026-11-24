import builtins
import errno
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import username_migration_blob_archive as archive
from username_migration_blob_tree import inventory


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = os.path.join(self.tmp.name, 'source')
        self.work = os.path.join(self.tmp.name, 'work')
        os.mkdir(self.source, 0o700)
        os.mkdir(self.work, 0o700)
        with open(os.path.join(self.source, 'data'), 'wb') as f:
            f.write(b'example\x00content')
        os.chmod(os.path.join(self.source, 'data'), 0o640)

    def capture(self):
        return archive.capture(self.source, self.work, 'backup.tar')

    def assert_clean(self):
        self.assertEqual(os.listdir(self.work), [])

    def test_roundtrip_content_mode_xattrs(self):
        path = os.path.join(self.source, 'data')
        try:
            os.setxattr(path, 'user.test', b'value')
        except OSError as exc:
            self.skipTest('xattrs unavailable: ' + str(exc))
        before = inventory(self.source)
        result = self.capture()
        restore = os.path.join(self.tmp.name, 'independent')
        os.mkdir(restore)
        archive._tar('--extract', '--file', result, '--acls', '--xattrs', '--xattrs-include=*',
                     '--numeric-owner', '--same-owner', '--same-permissions', '--directory', restore)
        self.assertEqual(before, inventory(restore))
        self.assertEqual(os.getxattr(os.path.join(restore, 'data'), 'user.test'), b'value')

    def test_bounded_capture_and_limit_cleanup(self):
        before = inventory(self.source)
        with self.assertRaisesRegex(archive.ArchiveError, 'hard write limit'):
            archive.capture(self.source, self.work, 'backup.tar', max_archive_size=512)
        self.assert_clean()
        self.assertEqual(before, inventory(self.source))
        result = archive.capture(self.source, self.work, 'backup.tar', max_archive_size=10240)
        self.assertLessEqual(os.path.getsize(result), 10240)
        self.assertEqual(before, inventory(self.source))

    def test_large_stderr_is_bounded_and_drained(self):
        before = inventory(self.source)
        real_popen = subprocess.Popen
        children = []
        def fake_tar(*args, **kwargs):
            code = ("import os\n"
                    "os.write(2, b'diagnostic:' + b'x' * 1000000)\n"
                    "os.write(1, b'archive')\n"
                    "raise SystemExit(1)\n")
            child = real_popen([sys.executable, '-c', code], **kwargs)
            children.append(child)
            return child
        def timeout(*_):
            raise TimeoutError('tar capture hung')
        previous = signal.signal(signal.SIGALRM, timeout)
        signal.alarm(10)
        try:
            with mock.patch.object(archive, '_check_tools'), \
                 mock.patch.object(archive.subprocess, 'Popen', side_effect=fake_tar), \
                 mock.patch.object(archive.tempfile, 'TemporaryFile', side_effect=AssertionError('unbounded file')):
                with self.assertRaises(archive.ArchiveError) as raised:
                    archive.capture(self.source, self.work, 'backup.tar', max_archive_size=10240)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
        message = str(raised.exception)
        self.assertTrue(message.startswith('tar failed: diagnostic:'))
        self.assertTrue(message.endswith('[stderr truncated]'))
        self.assertLess(len(message), 65600)
        self.assertIsNotNone(children[0].poll())
        self.assert_clean()
        self.assertEqual(before, inventory(self.source))

    def test_noisy_tar_is_killed_on_limit_or_disk_failure(self):
        before = inventory(self.source)
        real_popen = subprocess.Popen
        real_open = builtins.open
        children = []
        def fake_tar(*args, **kwargs):
            code = ("import os\n"
                    "while True:\n"
                    " os.write(2, b'e' * 65536)\n"
                    " os.write(1, b'a' * 65536)\n")
            child = real_popen([sys.executable, '-c', code], **kwargs)
            children.append(child)
            return child
        class FailingWriter:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def write(self, data):
                raise OSError(errno.ENOSPC, 'injected disk full')
        def failing_open(path, mode='r', *args, **kwargs):
            stream = real_open(path, mode, *args, **kwargs)
            if mode == 'xb' and os.path.basename(os.fspath(path)) == 'snapshot.tar':
                return FailingWriter(stream)
            return stream
        def timeout(*_):
            raise TimeoutError('tar capture hung')
        previous = signal.signal(signal.SIGALRM, timeout)
        try:
            for disk_failure in (False, True):
                signal.alarm(10)
                with mock.patch.object(archive, '_check_tools'), \
                     mock.patch.object(archive.subprocess, 'Popen', side_effect=fake_tar), \
                     mock.patch('builtins.open', side_effect=failing_open if disk_failure else real_open):
                    with self.assertRaises(archive.ArchiveError):
                        archive.capture(self.source, self.work, 'backup.tar',
                                        max_archive_size=1024 if not disk_failure else 1048576)
                signal.alarm(0)
                self.assertIsNotNone(children[-1].poll())
                self.assert_clean()
                self.assertEqual(before, inventory(self.source))
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)

    def test_inventory_limits_reject_before_archive_creation(self):
        with mock.patch.object(archive, '_create_bounded_archive') as create, \
             mock.patch('username_migration_blob_tree.hashlib.sha256') as digest:
            with self.assertRaisesRegex(archive.ArchiveError, 'file byte limit'):
                archive.capture(self.source, self.work, 'backup.tar', max_archive_size=10240,
                                inventory_limits={'max_file_bytes': 1})
        create.assert_not_called()
        digest.assert_not_called()
        self.assert_clean()

    def test_bounded_disk_write_failure_cleans_up(self):
        before = inventory(self.source)
        real_open = builtins.open
        class FailingWriter:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def write(self, data):
                raise OSError(errno.ENOSPC, 'injected disk full')
        def open_with_failure(path, mode='r', *args, **kwargs):
            stream = real_open(path, mode, *args, **kwargs)
            if mode == 'xb' and os.path.basename(os.fspath(path)) == 'snapshot.tar':
                return FailingWriter(stream)
            return stream
        with mock.patch('builtins.open', side_effect=open_with_failure):
            with self.assertRaises(archive.ArchiveError):
                archive.capture(self.source, self.work, 'backup.tar', max_archive_size=10240)
        self.assert_clean()
        self.assertEqual(before, inventory(self.source))

    def test_no_overwrite(self):
        output = os.path.join(self.work, 'backup.tar')
        with open(output, 'wb') as f:
            f.write(b'original')
        with self.assertRaises(archive.ArchiveError):
            self.capture()
        with open(output, 'rb') as f:
            self.assertEqual(f.read(), b'original')

    def test_corruption(self):
        real = archive._extract_bounded
        def corrupt(*args):
            with open(args[2], 'wb') as f:
                f.write(b'corrupt')
            return real(*args)
        with mock.patch.object(archive, '_extract_bounded', side_effect=corrupt):
            with self.assertRaises(archive.ArchiveError):
                self.capture()
        self.assert_clean()

    def test_extraction_failure_drains_and_bounds_diagnostics(self):
        before = inventory(self.source)
        real_popen = subprocess.Popen
        children = []
        def fake_popen(args, **kwargs):
            if '--extract' not in args:
                return real_popen(args, **kwargs)
            self.assertEqual(kwargs['stdout'], subprocess.DEVNULL)
            code = ("import os\n"
                    "os.write(1, b'o' * 1000000)\n"
                    "os.write(2, b'diagnostic:' + b'x' * 1000000)\n"
                    "raise SystemExit(1)\n")
            child = real_popen([sys.executable, '-c', code], **kwargs)
            children.append(child)
            return child
        def timeout(*_):
            raise TimeoutError('tar extraction hung')
        previous = signal.signal(signal.SIGALRM, timeout)
        signal.alarm(10)
        try:
            with mock.patch.object(archive.subprocess, 'Popen', side_effect=fake_popen):
                with self.assertRaises(archive.ArchiveError) as raised:
                    self.capture()
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
        message = str(raised.exception)
        self.assertTrue(message.startswith('tar failed: diagnostic:'))
        self.assertTrue(message.endswith('[stderr truncated]'))
        self.assertLess(len(message), 65600)
        self.assertIsNotNone(children[0].poll())
        self.assert_clean()
        self.assertEqual(before, inventory(self.source))

    def test_failed_comparison(self):
        real = archive.inventory
        calls = 0
        def mismatch(path):
            nonlocal calls
            calls += 1
            result = real(path)
            if calls == 2:
                result['version'] = 999
            return result
        with mock.patch.object(archive, 'inventory', side_effect=mismatch):
            with self.assertRaises(archive.ArchiveError):
                self.capture()
        self.assert_clean()

    def test_fsync_failures_cleanup(self):
        real = os.fsync
        for failure in (1, 2):
            calls = 0
            def fsync(fd):
                nonlocal calls
                calls += 1
                if calls == failure:
                    raise OSError('injected fsync failure')
                return real(fd)
            with mock.patch.object(archive.os, 'fsync', side_effect=fsync):
                with self.assertRaises(archive.ArchiveError):
                    self.capture()
            self.assert_clean()

    def test_reject_unsafe_and_special_entries(self):
        os.chmod(self.work, 0o755)
        with self.assertRaises(archive.ArchiveError):
            self.capture()
        os.chmod(self.work, 0o700)
        os.mkfifo(os.path.join(self.source, 'fifo'))
        with self.assertRaises(archive.ArchiveError):
            self.capture()
        self.assert_clean()


if __name__ == '__main__':
    unittest.main()
