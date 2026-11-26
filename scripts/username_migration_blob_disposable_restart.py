"""Test-only restartable restore for disposable directories, never live volumes.

The host and same-UID processes, all parent paths, fence, digest and inventory
must be trusted. This is not an authorization mechanism, lock, sandbox, or
proof of crash durability. The caller must keep writers stopped and the fence
held continuously; callbacks do not establish a physical fence. Trusted administrators
must continuously exclude mount and tree changes. Mount IDs can be reused and
checks do not prevent races. Hardlink aliases are not excluded. Use synthetic
data only. ACLs, xattrs and ownership depend on the host.
"""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile

from username_migration_blob_disk_snapshot import snapshot_and_validate
from username_migration_blob_restore import RestoreError
from username_migration_blob_tree import inventory
from username_migration_blob_tree_sync_testonly import sync_synthetic_tree
import username_migration_mount_check_testonly as mount_check

operational = False


def _identity(path):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise RestoreError('destination must be a real directory')
    return [st.st_dev, st.st_ino]


def _tar(fd, destination):
    os.lseek(fd, 0, os.SEEK_SET)
    subprocess.run(['tar', '--extract', '--file', '-', '--directory', destination,
                    '--same-owner', '--same-permissions', '--acls', '--xattrs',
                    '--xattrs-include=*', '--numeric-owner'], stdin=fd, check=True)


def _read_intent(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise RestoreError('intent must be a private owned regular file')
        with os.fdopen(fd, 'r', encoding='utf-8') as stream:
            fd = None
            return json.load(stream)
    finally:
        if fd is not None:
            os.close(fd)


def _persist(path, record):
    parent = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix='.restore-intent-', dir=parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(record, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        dfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except BaseException:
        # Keep any unpublished file, including partial writes, as failure evidence.
        # Make its directory entry durable when possible without masking the error.
        try:
            dfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
        raise


def restore(snapshot, snapshot_sha256, expected_inventory, destination, intent_path,
            fence, interrupt=None, *, workspace, max_archive_size, max_entries,
            max_depth, max_path_bytes, on_intent_published=None):
    """Restore synthetic data only; this function never authorizes a live volume.

    The private workspace and stable, trusted parents must be outside destination.
    Retrying always clears and restores again. The fence must return exactly True.
    """
    if not callable(fence):
        raise RestoreError('a fence callback is required')
    snapshot, destination, intent_path, workspace = map(
        lambda p: os.path.abspath(os.fspath(p)),
        (snapshot, destination, intent_path, workspace))
    for path in (snapshot, intent_path, workspace):
        # realpath catches aliases through existing symlinked parent paths.
        if os.path.commonpath([os.path.realpath(destination), os.path.realpath(path)]) == os.path.realpath(destination):
            raise RestoreError('snapshot, intent and workspace must be outside destination')
    identity = _identity(destination)
    inventory_hash = hashlib.sha256(json.dumps(expected_inventory, sort_keys=True,
                                               separators=(',', ':')).encode()).hexdigest()
    def open_root():
        fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        st = os.fstat(fd)
        if [st.st_dev, st.st_ino] != identity:
            os.close(fd)
            raise RestoreError('destination identity changed')
        return fd

    if fence('validate') is not True or _identity(destination) != identity:
        raise RestoreError('fence or destination identity changed')
    rootfd = open_root()
    try:
        root_mount = mount_check.mount_id(rootfd)
    finally:
        os.close(rootfd)
    record = {'version': 2, 'destination': destination, 'identity': identity,
              'root_mount_id': root_mount, 'snapshot_sha256': snapshot_sha256,
              'inventory_sha256': inventory_hash}

    def check(phase):
        if fence(phase) is not True:
            raise RestoreError('fence did not verify')
        if _identity(destination) != identity:
            raise RestoreError('destination identity changed')
        rootfd = open_root()
        try:
            if mount_check.mount_id(rootfd) != root_mount:
                raise RestoreError('destination mount ID changed')
        finally:
            os.close(rootfd)

    def check_mount_tree(phase):
        check(phase)
        rootfd = open_root()
        try:
            if mount_check.mount_id(rootfd) != root_mount:
                raise RestoreError('destination mount ID changed')
            mount_check.check_tree(rootfd, max_entries=max_entries, max_depth=max_depth,
                                   max_path_bytes=max_path_bytes,
                                   fence=lambda: (check(phase) or True))
            check(phase)
        finally:
            os.close(rootfd)

    def injected(step):
        if interrupt is not None:
            interrupt(step)

    check('validate')
    fd = snapshot_and_validate(snapshot, snapshot_sha256, workspace,
                               max_archive_size=max_archive_size, max_entries=max_entries)
    try:
        if os.path.lexists(intent_path) and _read_intent(intent_path) != record:
            raise RestoreError('intent does not match this restore')
        with tempfile.TemporaryDirectory(prefix='blob-restore-check-', dir=workspace) as verified:
            _tar(fd, verified)
            if inventory(verified) != expected_inventory:
                raise RestoreError('snapshot inventory mismatch')
        check('intent')
        # Recheck after the fence callback and before replacing the intent.
        if os.path.lexists(intent_path) and _read_intent(intent_path) != record:
            raise RestoreError('intent does not match this restore')
        _persist(intent_path, record)
        if on_intent_published is not None:
            on_intent_published()
        injected('intent')
        check_mount_tree('clear')
        destfd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            st = os.fstat(destfd)
            if [st.st_dev, st.st_ino] != identity:
                raise RestoreError('destination identity changed')
            for name in os.listdir(destfd):
                check('remove')
                st = os.stat(name, dir_fd=destfd, follow_symlinks=False)
                if stat.S_ISDIR(st.st_mode):
                    shutil.rmtree(name, dir_fd=destfd)
                else:
                    os.unlink(name, dir_fd=destfd)
                os.fsync(destfd)
                check('remove-complete')
                injected('remove')
            os.fsync(destfd)
        finally:
            os.close(destfd)
        injected('clear')
        check_mount_tree('extract')
        _tar(fd, destination)
        injected('extract')
        check('verify')
        if inventory(destination) != expected_inventory:
            raise RestoreError('restored inventory mismatch')
        check_mount_tree('sync')
        sync_synthetic_tree(destination, lambda: check('sync'),
                            root_mount_id=root_mount, max_entries=max_entries, max_depth=max_depth,
                            max_path_bytes=max_path_bytes)
        check('complete')
    finally:
        os.close(fd)
