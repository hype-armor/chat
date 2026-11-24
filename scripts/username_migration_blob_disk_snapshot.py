#!/usr/bin/env python3
"""Experimental disk-backed blob archive preflight; this does not restore data.

The directory, archive and digest require protection from same-UID and
privileged writers. Filesystem type checks cannot prove the backing storage of
stacked, remote, or virtual filesystems. The caller must assess that boundary.
Close the returned descriptor. Linux O_TMPFILE and procfs are required.
"""
import ctypes
import hashlib
import os
import re
import stat
import tarfile

from username_migration_blob_restore import RestoreError

# Linux statfs magic values for RAM-based filesystems.
_MEMORY_FILESYSTEMS = {0x01021994, 0x858458f6, 0x958458f6}


def _check_disk_filesystem(fd):
    # Allocate more than struct statfs needs, including on 32-bit systems.
    buf = ctypes.create_string_buffer(256)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(fd, ctypes.byref(buf)) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    magic = ctypes.cast(buf, ctypes.POINTER(ctypes.c_long)).contents.value & 0xffffffff
    if magic in _MEMORY_FILESYSTEMS:
        raise RestoreError('snapshot directory is on a memory-backed filesystem')


# Tar parsing seeks over ordinary file payloads. Bound both individual metadata
# reads and their total, including chained extended headers and sparse metadata.
_MAX_TAR_METADATA_READ = 1024 * 1024
_MAX_TAR_METADATA_TOTAL = 64 * 1024 * 1024


class _BoundedTarReader:
    """Limit tarfile metadata reads before the underlying allocation."""

    def __init__(self, stream, size):
        self.stream = stream
        self.size = size
        self.metadata_read = 0

    def read(self, size=-1):
        remaining = max(0, self.size - self.stream.tell())
        requested = remaining if size < 0 else size
        if requested > _MAX_TAR_METADATA_READ:
            raise RestoreError('tar metadata read exceeds limit')
        count = min(requested, remaining)
        if count > _MAX_TAR_METADATA_TOTAL - self.metadata_read:
            raise RestoreError('tar metadata total exceeds limit')
        data = self.stream.read(count)
        self.metadata_read += len(data)
        return data

    def seek(self, *args):
        return self.stream.seek(*args)

    def tell(self):
        return self.stream.tell()


def _validate_tar(fd, max_entries):
    seen = {}
    size = os.fstat(fd).st_size
    os.lseek(fd, 0, os.SEEK_SET)
    with os.fdopen(os.dup(fd), 'rb') as stream, \
            tarfile.open(fileobj=_BoundedTarReader(stream, size), mode='r:') as tar:
        for member in tar:
            if len(seen) >= max_entries:
                raise RestoreError('archive exceeds entry limit')
            name = member.name
            if name == '.':
                parts = []
            else:
                if name.startswith('./'):
                    name = name[2:]
                parts = name.split('/')
                if any(part in ('', '.', '..') for part in parts) or name.startswith('/'):
                    raise RestoreError('unsafe archive path')
            key = '/'.join(parts)
            if key in seen or not (member.isdir() or member.type in (tarfile.REGTYPE, tarfile.AREGTYPE)):
                raise RestoreError('duplicate or unsupported archive entry')
            if any(seen.get('/'.join(parts[:i])) != 'directory' for i in range(len(parts))):
                raise RestoreError('missing or non-directory parent')
            for paxkey in member.pax_headers:
                if not (paxkey in ('path', 'mtime', 'atime', 'ctime', 'size', 'uid', 'gid', 'uname', 'gname')
                        or paxkey.startswith('SCHILY.xattr.') or paxkey in ('SCHILY.acl.access', 'SCHILY.acl.default')):
                    raise RestoreError('unsupported PAX metadata')
            seen[key] = 'directory' if member.isdir() else 'file'
    if seen.get('') != 'directory':
        raise RestoreError('archive has no root directory')
    os.lseek(fd, 0, os.SEEK_SET)


def snapshot_and_validate(path, trusted_sha256, workspace, *, max_archive_size, max_entries):
    """Return a read-only anonymous snapshot fd after digest and tar checks.

    The digest must come from independently authenticated durable state. This
    function does not establish trust, fence writers, or authorize a restore.
    The workspace must be an owned private directory on a suitable filesystem.
    Limits are positive integers: archive bytes and logical tar entries, including
    the root directory. Choose limits that fit the available disk and memory.
    """
    if any(type(value) is not int or value <= 0 for value in (max_archive_size, max_entries)):
        raise RestoreError('archive size and entry limits must be positive integers')
    if not isinstance(trusted_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', trusted_sha256):
        raise RestoreError('invalid trusted digest')
    directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    source = writable = readonly = None
    try:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RestoreError('workspace must be an owned private directory')
        _check_disk_filesystem(directory)
        source = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        before = os.fstat(source)
        if not stat.S_ISREG(before.st_mode):
            raise RestoreError('archive must be a regular file')
        if before.st_size > max_archive_size:
            raise RestoreError('archive exceeds size limit')
        writable = os.open('.', os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=directory)
        digest = hashlib.sha256()
        copied = 0
        while True:
            chunk = os.read(source, min(1024 * 1024, max_archive_size - copied + 1))
            if not chunk:
                break
            if len(chunk) > max_archive_size - copied:
                raise RestoreError('archive exceeds size limit')
            copied += len(chunk)
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                count = os.write(writable, view)
                if count <= 0:
                    raise RestoreError('snapshot write failed')
                view = view[count:]
        after = os.fstat(source)
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if signature(before) != signature(after) or digest.hexdigest() != trusted_sha256:
            raise RestoreError('archive changed or digest does not match trusted state')
        os.fsync(writable)
        readonly = os.open('/proc/self/fd/' + str(writable), os.O_RDONLY | os.O_CLOEXEC)
        original, reopened = os.fstat(writable), os.fstat(readonly)
        if (original.st_dev, original.st_ino) != (reopened.st_dev, reopened.st_ino):
            raise RestoreError('archive snapshot identity changed')
        os.close(writable)
        writable = None
        _validate_tar(readonly, max_entries)
        result, readonly = readonly, None
        return result
    except (tarfile.TarError, EOFError, RecursionError) as exc:
        raise RestoreError('invalid tar archive') from exc
    finally:
        for fd in (readonly, writable, source, directory):
            if fd is not None:
                os.close(fd)
