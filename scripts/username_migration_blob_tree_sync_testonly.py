"""Test-only tree sync. This does not authorize an operational restore.

The caller must keep the synthetic tree and its ancestors unchanged under an
external fence. Trusted administrators must exclude mount and tree changes.
Mount ID checks cannot provide continuous exclusion, prevent races, or exclude
all hardlink aliases. This is not operational safety. A successful fsync also
depends on the filesystem and storage honoring their durability contracts.
"""
import os
import stat

import username_migration_mount_check_testonly as mount_check


class TreeSyncError(RuntimeError):
    """The tree could not be safely synchronized."""


def _identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_size,
            st.st_mtime_ns, st.st_ctime_ns)


def sync_synthetic_tree(root, assert_fence, *, root_mount_id, max_entries, max_depth,
                        max_path_bytes, fsync=os.fsync):
    """Sync a fenced synthetic tree, or raise on any uncertainty.

    assert_fence must raise when its test fence is not held. No result from
    this function proves that an operational writer fence exists. Limits count
    entries below the root, their depth (root is 0), and the sum of their
    relative path lengths in filesystem-encoded bytes. Depth is capped at 128
    to keep the recursive traversal within Python's stack limit.
    """
    for name, value in (("max_entries", max_entries), ("max_depth", max_depth),
                        ("max_path_bytes", max_path_bytes)):
        if type(value) is not int or value < 0:
            raise ValueError(f"{name} must be a nonnegative integer")
    if max_depth > 128:
        raise ValueError("max_depth must not exceed 128")
    if type(root_mount_id) is not int or root_mount_id < 0:
        raise ValueError("root_mount_id must be a nonnegative integer")
    entries = 0
    path_bytes = 0
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    dirflags = flags | os.O_DIRECTORY

    def fence():
        assert_fence()

    def check_mount(fd):
        fence()
        if mount_check.mount_id(fd) != root_mount_id:
            raise TreeSyncError("mount ID mismatch")
        fence()

    def same(a, b):
        if _identity(a) != _identity(b):
            raise TreeSyncError("entry identity or metadata changed")

    def scan(fd, depth, prefix_bytes, expected=None):
        nonlocal entries, path_bytes
        names = []
        local_bytes = 0
        with os.scandir(fd) as iterator:
            for entry in iterator:
                fence()
                name = entry.name
                length = prefix_bytes + (1 if depth > 1 else 0) + len(os.fsencode(name))
                if expected is None:
                    if entries >= max_entries:
                        raise TreeSyncError("entry limit exceeded")
                    if depth > max_depth:
                        raise TreeSyncError("depth limit exceeded")
                    if length > max_path_bytes - path_bytes:
                        raise TreeSyncError("path-byte limit exceeded")
                    entries += 1
                    path_bytes += length
                else:
                    # A changed directory must not make the verification scan
                    # allocate more than the original bounded scan.
                    local_bytes += len(os.fsencode(name))
                    if len(names) >= expected[0] or local_bytes > expected[1]:
                        raise TreeSyncError("directory contents changed")
                names.append(name)
        return sorted(names)

    def walk(fd, initial, device, depth, prefix_bytes):
        fence()
        same(initial, os.fstat(fd))
        check_mount(fd)
        names = scan(fd, depth + 1, prefix_bytes)
        name_bytes = sum(len(os.fsencode(name)) for name in names)
        for name in names:
            fence()
            before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if before.st_dev != device:
                raise TreeSyncError("cross-device entry")
            if stat.S_ISDIR(before.st_mode):
                openflags = dirflags
            elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
                openflags = flags | os.O_NONBLOCK
            else:
                raise TreeSyncError("link or unsupported entry")
            child = os.open(name, openflags, dir_fd=fd)
            try:
                same(before, os.fstat(child))
                check_mount(child)
                if stat.S_ISDIR(before.st_mode):
                    length = prefix_bytes + (1 if depth else 0) + len(os.fsencode(name))
                    walk(child, before, device, depth + 1, length)
                else:
                    check_mount(child)
                    fsync(child)
                    check_mount(child)
                    same(before, os.fstat(child))
                same(before, os.stat(name, dir_fd=fd, follow_symlinks=False))
            finally:
                os.close(child)
        fence()
        same(initial, os.fstat(fd))
        if names != scan(fd, depth + 1, prefix_bytes, (len(names), name_bytes)):
            raise TreeSyncError("directory contents changed")
        check_mount(fd)
        fsync(fd)
        check_mount(fd)
        same(initial, os.fstat(fd))

    try:
        fence()
        before = os.stat(root, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode):
            raise TreeSyncError("root is not a directory")
        fd = os.open(root, dirflags)
        try:
            same(before, os.fstat(fd))
            walk(fd, before, before.st_dev, 0, 0)
            same(before, os.stat(root, follow_symlinks=False))
            fence()
        finally:
            os.close(fd)
    except OSError as exc:
        raise TreeSyncError("tree synchronization failed") from exc
