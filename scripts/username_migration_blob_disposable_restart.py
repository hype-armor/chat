"""Restartable restore experiment for private, disposable directories only.

Not a live adapter or an operational command. The caller must stop all writers,
keep the fence held throughout each call, and supply a trusted GNU tar archive,
its independent SHA-256 digest, and an independent blob-tree inventory. Archive
contents must be trusted: tar extraction is not a sandbox. This helper does not
provide a process lock, defend against hostile same-user processes, or prove
crash durability of restored file data. ACLs, xattrs, and ownership require
filesystem and privilege support. Any mismatch fails closed.
"""

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile

from username_migration_blob_tree import inventory

operational = False


class RestoreError(Exception):
    pass


def _digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def _identity(path):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise RestoreError('destination must be a real directory')
    return [st.st_dev, st.st_ino]


def _tar(snapshot, destination):
    subprocess.run(['tar', '--extract', '--file', snapshot, '--directory', destination,
                    '--same-owner', '--same-permissions', '--acls', '--xattrs',
                    '--xattrs-include=*', '--numeric-owner'], check=True)


def _persist(path, record):
    parent = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix='.restore-intent-', dir=parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(record, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        dfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def restore(snapshot, snapshot_sha256, expected_inventory, destination, intent_path,
            fence, interrupt=None):
    """Restore into a disposable directory. `fence(phase)` must raise on failure.

    `interrupt(step)` is a test hook after intent, each remove, clear, and extract. Retrying
    always clears and restores again. Keep the intent outside the destination.
    The destination and all parent paths must be private and stable.
    """
    if not callable(fence):
        raise RestoreError('a fence callback is required')
    snapshot = os.path.abspath(os.fspath(snapshot))
    destination = os.path.abspath(os.fspath(destination))
    intent_path = os.path.abspath(os.fspath(intent_path))
    if os.path.commonpath([destination, intent_path]) == destination:
        raise RestoreError('intent must be outside destination')
    if os.path.commonpath([destination, snapshot]) == destination:
        raise RestoreError('snapshot must be outside destination')
    identity = _identity(destination)
    inventory_hash = hashlib.sha256(json.dumps(expected_inventory, sort_keys=True,
                                               separators=(',', ':')).encode()).hexdigest()
    record = {'version': 1, 'destination': destination, 'identity': identity,
              'snapshot_sha256': snapshot_sha256, 'inventory_sha256': inventory_hash}

    def check(phase):
        fence(phase)
        if _identity(destination) != identity:
            raise RestoreError('destination identity changed')

    def injected(step):
        if interrupt is not None:
            interrupt(step)

    check('validate')
    if _digest(snapshot) != snapshot_sha256:
        raise RestoreError('snapshot digest mismatch')
    if os.path.lexists(intent_path):
        with open(intent_path, encoding='utf-8') as stream:
            if json.load(stream) != record:
                raise RestoreError('intent does not match this restore')
    # Verify the archive on disk, not a newly generated source inventory.
    with tempfile.TemporaryDirectory(prefix='blob-restore-check-') as verified:
        _tar(snapshot, verified)
        if inventory(verified) != expected_inventory:
            raise RestoreError('snapshot inventory mismatch')
    check('intent')
    _persist(intent_path, record)
    injected('intent')
    check('clear')
    fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if [st.st_dev, st.st_ino] != identity:
            raise RestoreError('destination identity changed')
        for name in os.listdir(fd):
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                shutil.rmtree(name, dir_fd=fd)
            else:
                os.unlink(name, dir_fd=fd)
            os.fsync(fd)
            injected('remove')
        os.fsync(fd)
    finally:
        os.close(fd)
    injected('clear')
    check('extract')
    if _digest(snapshot) != snapshot_sha256:
        raise RestoreError('snapshot digest changed')
    _tar(snapshot, destination)
    injected('extract')
    check('verify')
    if inventory(destination) != expected_inventory:
        raise RestoreError('restored inventory mismatch')
    check('complete')
