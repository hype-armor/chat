"""Linux-only synthetic mount-boundary check. Not an operational fence.

Trusted administrators must exclude mount changes throughout traversal. Mount IDs
can be reused, and this check does not prevent concurrent changes. It is not
restore authorization. Callers must also exclude concurrent tree modifications;
identity checks detect some drift but do not provide a snapshot.
"""
import ctypes
import errno
import os
import stat
import struct
import sys


class Unsupported(RuntimeError):
    """The required Linux statx mount ID facility is unavailable."""


class UnsafeTree(RuntimeError):
    """A mount boundary, symlink, or identity change was detected."""


STATX_MNT_ID = 0x1000
AT_EMPTY_PATH = 0x1000


def mount_id(fd):
    """Return the kernel mount ID of an open descriptor, or fail closed."""
    if sys.platform != 'linux':
        raise Unsupported('Linux statx is required')
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        call = libc.statx
    except AttributeError as exc:
        raise Unsupported('libc statx is unavailable') from exc
    call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                     ctypes.c_uint, ctypes.c_void_p]
    call.restype = ctypes.c_int
    # Linux struct statx is 256 bytes; stx_mnt_id is at byte 144.
    result = ctypes.create_string_buffer(256)
    if call(fd, b'', AT_EMPTY_PATH, STATX_MNT_ID, result) != 0:
        code = ctypes.get_errno()
        if code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            raise Unsupported('statx mount ID is unavailable')
        raise OSError(code, os.strerror(code))
    mask = struct.unpack_from('=I', result.raw, 0)[0]
    if not mask & STATX_MNT_ID:
        raise Unsupported('statx did not return a mount ID')
    return struct.unpack_from('=Q', result.raw, 144)[0]


def _identity(info):
    return info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)


def check_tree(root_fd, *, max_entries, max_depth, max_path_bytes, fence):
    """Check a tree under explicit limits and a caller-supplied fence check.

    Depth and path bytes are relative to the root; separators count as bytes.
    Entries exclude the root. The fence must return True on every check.
    This does not authorize a restore or replace trusted administrator controls.
    Any error aborts the check. The caller retains ownership of root_fd.
    """
    for value in (max_entries, max_depth, max_path_bytes):
        if type(value) is not int or value < 0:
            raise ValueError('limits must be non-negative finite integers')
    if not callable(fence):
        raise ValueError('fence callback is required')

    def check_fence():
        try:
            valid = fence()
        except Exception as exc:
            raise UnsafeTree('fence check failed') from exc
        if valid is not True:
            raise UnsafeTree('fence changed')

    check_fence()
    if sys.platform != 'linux' or not hasattr(os, 'O_PATH'):
        raise Unsupported('Linux O_PATH is required')
    root = os.dup(root_fd)
    try:
        if not stat.S_ISDIR(os.fstat(root).st_mode):
            raise UnsafeTree('root is not a directory')
        expected_mount = mount_id(root)

        entries = 0

        def walk(directory, depth, path_bytes):
            nonlocal entries
            check_fence()
            before = os.fstat(directory)
            if mount_id(directory) != expected_mount:
                raise UnsafeTree('mount boundary')
            # Reopen O_PATH directories for enumeration, and verify identity.
            readable = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=directory)
            try:
                if _identity(os.fstat(readable)) != _identity(before):
                    raise UnsafeTree('directory identity drift')
                if mount_id(readable) != expected_mount:
                    raise UnsafeTree('mount boundary')
                with os.scandir(readable) as scan:
                    for entry in scan:
                        check_fence()
                        entries += 1
                        name = entry.name
                        child_depth = depth + 1
                        child_bytes = path_bytes + (1 if depth else 0) + len(os.fsencode(name))
                        if entries > max_entries:
                            raise UnsafeTree('entry limit exceeded')
                        if child_depth > max_depth:
                            raise UnsafeTree('path depth limit exceeded')
                        if child_bytes > max_path_bytes:
                            raise UnsafeTree('path byte limit exceeded')
                        prior = os.stat(name, dir_fd=readable, follow_symlinks=False)
                        child = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=readable)
                        try:
                            opened = os.fstat(child)
                            if _identity(prior) != _identity(opened):
                                raise UnsafeTree('entry identity drift')
                            if stat.S_ISLNK(opened.st_mode):
                                raise UnsafeTree('symlink')
                            if mount_id(child) != expected_mount:
                                raise UnsafeTree('mount boundary')
                            if stat.S_ISDIR(opened.st_mode):
                                walk(child, child_depth, child_bytes)
                            after = os.stat(name, dir_fd=readable, follow_symlinks=False)
                            if _identity(after) != _identity(opened):
                                raise UnsafeTree('entry identity drift')
                            check_fence()
                        finally:
                            os.close(child)
                check_fence()
                if _identity(os.fstat(readable)) != _identity(before):
                    raise UnsafeTree('directory identity drift')
            finally:
                os.close(readable)
        walk(root, 0, 0)
        check_fence()
    finally:
        os.close(root)
