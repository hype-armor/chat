import hashlib
import io
import os
import tarfile
import tempfile
import unittest
from unittest import mock

import username_migration_blob_disk_snapshot as disk
from username_migration_blob_restore import RestoreError


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for name, kind, pax in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.pax_headers = pax
            tar.addfile(item)
    return stream.getvalue()


ROOT = ('.', tarfile.DIRTYPE, {})


class DiskSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'source.tar')

    def snapshot(self, data, digest=None, *, max_archive_size=1024 * 1024, max_entries=100):
        with open(self.path, 'wb') as stream:
            stream.write(data)
        return disk.snapshot_and_validate(
            self.path, digest or hashlib.sha256(data).hexdigest(), self.tmp.name,
            max_archive_size=max_archive_size, max_entries=max_entries)

    def test_snapshot_is_read_only_and_independent(self):
        data = archive([ROOT, ('./file', tarfile.REGTYPE, {})])
        fd = self.snapshot(data)
        self.addCleanup(os.close, fd)
        with open(self.path, 'wb') as stream:
            stream.write(b'changed')
        self.assertEqual(os.read(fd, len(data)), data)
        with self.assertRaises(OSError):
            os.write(fd, b'x')
        self.assertEqual(os.fstat(fd).st_nlink, 0)

    def test_reject_digest_and_invalid_archive(self):
        with self.assertRaises(RestoreError):
            self.snapshot(archive([ROOT]), '0' * 64)
        with self.assertRaises(RestoreError):
            self.snapshot(b'not a tar')

    def test_reject_unsafe_entries(self):
        for entries in ([ROOT, ('../escape', tarfile.REGTYPE, {})],
                        [ROOT, ('./link', tarfile.SYMTYPE, {})],
                        [ROOT, ('./sparse', tarfile.GNUTYPE_SPARSE, {})],
                        [ROOT, ROOT],
                        [ROOT, ('./missing/file', tarfile.REGTYPE, {})],
                        [ROOT, ('./file', tarfile.REGTYPE, {'unknown': 'x'})],
                        [('file', tarfile.REGTYPE, {})]):
            with self.subTest(entries=entries), self.assertRaises(RestoreError):
                self.snapshot(archive(entries))

    def test_private_directory_and_memory_filesystem(self):
        data = archive([ROOT])
        os.chmod(self.tmp.name, 0o755)
        with self.assertRaises(RestoreError):
            self.snapshot(data)
        os.chmod(self.tmp.name, 0o700)
        if os.path.isdir('/dev/shm'):
            with tempfile.TemporaryDirectory(dir='/dev/shm') as tmp:
                with self.assertRaises(RestoreError):
                    disk.snapshot_and_validate(self.path, hashlib.sha256(data).hexdigest(), tmp,
                                               max_archive_size=len(data), max_entries=1)

    def test_required_positive_limits(self):
        data = archive([ROOT])
        for size, entries in ((0, 1), (-1, 1), (1, 0), (1, -1),
                              (True, 1), (1, False), (1.5, 1), (1, '1')):
            with self.subTest(size=size, entries=entries), self.assertRaises(RestoreError):
                self.snapshot(data, max_archive_size=size, max_entries=entries)
        with self.assertRaises(TypeError):
            disk.snapshot_and_validate(self.path, hashlib.sha256(data).hexdigest(), self.tmp.name)

    def test_size_and_entry_limits(self):
        data = archive([ROOT, ('./file', tarfile.REGTYPE, {})])
        with mock.patch.object(disk.os, 'write', wraps=os.write) as write:
            with self.assertRaisesRegex(RestoreError, 'size limit'):
                self.snapshot(data, max_archive_size=len(data) - 1)
            write.assert_not_called()
        with self.assertRaisesRegex(RestoreError, 'entry limit'):
            self.snapshot(data, max_archive_size=len(data), max_entries=1)
        fd = self.snapshot(data, max_archive_size=len(data), max_entries=2)
        os.close(fd)

    def test_growth_during_read_does_not_write_past_limit(self):
        data = archive([ROOT])
        original_read, original_write = os.read, os.write
        grown = False
        written = 0

        def growing_read(fd, count):
            nonlocal grown
            chunk = original_read(fd, count)
            if chunk and not grown:
                grown = True
                with open(self.path, 'ab') as stream:
                    stream.write(b'x')
            return chunk

        def counting_write(fd, chunk):
            nonlocal written
            result = original_write(fd, chunk)
            written += result
            return result

        with mock.patch.object(disk.os, 'read', side_effect=growing_read), \
             mock.patch.object(disk.os, 'write', side_effect=counting_write):
            with self.assertRaisesRegex(RestoreError, 'size limit'):
                self.snapshot(data, max_archive_size=len(data))
        self.assertTrue(grown)
        self.assertLessEqual(written, len(data))

    def test_forged_extended_header_read_is_bounded(self):
        item = tarfile.TarInfo('./pax')
        item.type = tarfile.XHDTYPE
        item.size = 2 ** 40
        data = item.tobuf(format=tarfile.GNU_FORMAT) + b'\0' * 1024
        with self.assertRaises(RestoreError):
            self.snapshot(data, max_archive_size=len(data))
        stream = mock.Mock()
        stream.tell.return_value = 5
        reader = disk._BoundedTarReader(stream, 2 ** 40)
        with self.assertRaisesRegex(RestoreError, 'metadata read'):
            reader.read(2 ** 39)
        stream.read.assert_not_called()

    def test_forged_large_metadata_types_rejected_before_read(self):
        for kind in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME,
                     tarfile.GNUTYPE_LONGLINK):
            with self.subTest(kind=kind):
                item = tarfile.TarInfo('./metadata')
                item.type = kind
                item.size = 2 ** 32
                header = item.tobuf(format=tarfile.GNU_FORMAT)
                # A sparse file makes the claimed bytes available without allocation.
                with open(self.path, 'wb') as stream:
                    stream.write(header)
                    stream.truncate(item.size + 512)
                with open(self.path, 'rb') as stream:
                    with self.assertRaisesRegex(RestoreError, 'metadata read'):
                        disk._validate_tar(stream.fileno(), 100)

    def test_metadata_total_limit(self):
        stream = io.BytesIO(b'x' * 16)
        reader = disk._BoundedTarReader(stream, 16)
        with mock.patch.object(disk, '_MAX_TAR_METADATA_TOTAL', 8):
            self.assertEqual(reader.read(8), b'x' * 8)
            with self.assertRaisesRegex(RestoreError, 'metadata total'):
                reader.read(1)

    def test_normal_gnu_and_pax_metadata_and_payload(self):
        for fmt in (tarfile.GNU_FORMAT, tarfile.PAX_FORMAT):
            with self.subTest(format=fmt):
                output = io.BytesIO()
                name = './' + 'n' * 150
                payload = b'x' * (disk._MAX_TAR_METADATA_READ + 1)
                with tarfile.open(fileobj=output, mode='w', format=fmt) as tar:
                    root = tarfile.TarInfo('.')
                    root.type = tarfile.DIRTYPE
                    tar.addfile(root)
                    item = tarfile.TarInfo(name)
                    item.size = len(payload)
                    if fmt == tarfile.PAX_FORMAT:
                        item.pax_headers = {'SCHILY.xattr.user.test': 'value'}
                    tar.addfile(item, io.BytesIO(payload))
                data = output.getvalue()
                fd = self.snapshot(data, max_archive_size=len(data))
                os.close(fd)

    def test_short_writes_are_retried(self):
        data = archive([ROOT])
        original_write = os.write
        calls = 0

        def short_write(fd, chunk):
            nonlocal calls
            calls += 1
            return original_write(fd, chunk[:max(1, len(chunk) // 2)])

        with mock.patch.object(disk.os, 'write', side_effect=short_write):
            fd = self.snapshot(data, max_archive_size=len(data))
        self.addCleanup(os.close, fd)
        self.assertGreater(calls, 1)
        self.assertEqual(os.read(fd, len(data)), data)

    def test_zero_write_fails(self):
        with mock.patch.object(disk.os, 'write', return_value=0):
            with self.assertRaisesRegex(RestoreError, 'write failed'):
                self.snapshot(archive([ROOT]))

    def test_source_change_detected(self):
        data = archive([ROOT])
        original = disk.os.fstat
        calls = 0
        def changed(fd):
            nonlocal calls
            result = original(fd)
            calls += 1
            if calls == 3:
                values = list(result)
                values[6] += 1
                return os.stat_result(values)
            return result
        with mock.patch.object(disk.os, 'fstat', side_effect=changed):
            with self.assertRaises(RestoreError):
                self.snapshot(data)


if __name__ == '__main__':
    unittest.main()
