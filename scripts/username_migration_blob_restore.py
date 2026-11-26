#!/usr/bin/env python3
"""Experimental archive preflight only. Destructive restore is disabled.

This module does not establish a writer fence, authenticate operation state,
create a disposable target, or authorize any live volume operation. The caller
must protect the input and trusted digest from same-UID and privileged writers.
The validator deliberately rejects links, special files, and unknown PAX keys.
It is a conservative preflight, not a complete archive compatibility test.
"""
import fcntl
import hashlib
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

from username_migration_blob_tree import inventory


class RestoreError(RuntimeError):
    pass


def snapshot_and_validate(path, trusted_sha256):
    """Return a sealed anonymous archive fd after digest and tar checks.

    The digest must come from independently authenticated durable operation
    state. This function does not establish that trust. Close the returned fd.
    No filesystem target is created or changed.
    """
    if not isinstance(trusted_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', trusted_sha256):
        raise RestoreError('invalid trusted digest')
    source = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    snapshot = None
    try:
        before = os.fstat(source)
        if not stat.S_ISREG(before.st_mode):
            raise RestoreError('archive must be a regular file')
        # This experimental sealed-memory adapter is not suitable for large
        # production volumes. Reject them rather than exhaust host memory.
        if before.st_size > 256 * 1024 * 1024:
            raise RestoreError('archive exceeds experimental memory limit')
        snapshot = os.memfd_create('blob-restore-preflight', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        digest = hashlib.sha256()
        while True:
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                n = os.write(snapshot, view)
                if n <= 0:
                    raise RestoreError('snapshot write failed')
                view = view[n:]
        after = os.fstat(source)
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if signature(before) != signature(after) or digest.hexdigest() != trusted_sha256:
            raise RestoreError('archive changed or digest does not match trusted state')
        fcntl.fcntl(snapshot, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
        os.lseek(snapshot, 0, os.SEEK_SET)
        seen = {}
        with os.fdopen(os.dup(snapshot), 'rb') as stream, tarfile.open(fileobj=stream, mode='r:') as tar:
            for member in tar:
                name = member.name
                # GNU tar emits the root as '.' and descendants as './name'.
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
        os.lseek(snapshot, 0, os.SEEK_SET)
        result, snapshot = snapshot, None
        return result
    except (tarfile.TarError, EOFError) as exc:
        raise RestoreError('invalid tar archive') from exc
    finally:
        os.close(source)
        if snapshot is not None:
            os.close(snapshot)


def _restore_disposable_test_only(*, archive_path, trusted_sha256, expected_inventory, workspace):
    """Extract and compare only in a newly created disposable test directory.

    The expected inventory and digest must come from independently protected
    durable evidence. This test helper cannot establish that provenance, fence
    writers, or restore an existing volume. Never use it for live data.
    """
    info = os.lstat(workspace)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise RestoreError('workspace must be an owned private directory')
    fd = snapshot_and_validate(archive_path, trusted_sha256)
    target = None
    before = None
    try:
        target = tempfile.mkdtemp(prefix='disposable-blob-restore-', dir=workspace)
        before = os.lstat(target)
        result = subprocess.run(['tar', '--extract', '--file', '-', '--acls', '--xattrs',
                                 '--xattrs-include=*', '--numeric-owner', '--same-owner',
                                 '--same-permissions', '--directory', target], stdin=fd,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        after = os.lstat(target)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) or not stat.S_ISDIR(after.st_mode):
            target = None  # Never remove a replacement we did not create.
            raise RestoreError('disposable restore directory changed')
        if result.returncode or inventory(target) != expected_inventory:
            raise RestoreError('disposable restore verification failed')
        result_target, target = target, None
        return result_target
    finally:
        os.close(fd)
        if target is not None and before is not None:
            # Recheck immediately before removing only the directory we created.
            try:
                current = os.lstat(target)
                if (before.st_dev, before.st_ino) == (current.st_dev, current.st_ino) and stat.S_ISDIR(current.st_mode):
                    shutil.rmtree(target)
            except FileNotFoundError:
                pass


def restore(*args, **kwargs):
    """Fail closed: this module cannot restore a live Docker volume."""
    raise RestoreError('restore disabled: durable trusted state, volume identity, and continuous writer fencing are not implemented')
