#!/usr/bin/env python3
"""Experimental local-volume restore preflight. Not an operational restore.

The caller must hold an external writer and restart fence and protect the
workspace, Docker socket and evidence from privileged and same-UID writers.
This module never invokes Docker itself and never changes a volume. Linux
fs-verity is required for disk-backed immutable archive staging. Filesystems
without fs-verity fail closed. No updater integration is provided.
"""
import fcntl
import hashlib
import os
import re
import stat
import struct
import tarfile
import tempfile

import username_migration_blob_local_volume as local

operational = False


class RestoreError(RuntimeError):
    pass


def _guard(check):
    if check() is not True:
        raise RestoreError('pre-cutover boundary or external fence not held')


def _stage_verity(path, digest, workspace):
    """Copy to a private disk file and enable kernel-enforced fs-verity.

    Return an open read-only fd and unlink the name. The SHA-256 digest is
    independently checked over the staged bytes. Close the returned fd.
    Workspace storage, kernel and the expected digest must be trusted.
    """
    if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
        raise RestoreError('invalid trusted archive digest')
    st = os.lstat(workspace)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise RestoreError('workspace must be an owned private directory')
    src = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    name = None
    out = None
    try:
        before = os.fstat(src)
        if not stat.S_ISREG(before.st_mode):
            raise RestoreError('archive is not a regular file')
        out, name = tempfile.mkstemp(prefix='.blob-verity-', dir=workspace)
        h = hashlib.sha256()
        while True:
            block = os.read(src, 1024 * 1024)
            if not block:
                break
            h.update(block)
            view = memoryview(block)
            while view:
                count = os.write(out, view)
                if not count:
                    raise RestoreError('staging write failed')
                view = view[count:]
        after = os.fstat(src)
        sig = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if sig(before) != sig(after) or h.hexdigest() != digest:
            raise RestoreError('archive changed or digest mismatch')
        os.fsync(out)
        os.close(out)
        out = None
        out = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        # struct fsverity_enable_arg, Linux uapi. Enable fails if an open
        # writable fd exists, or if the filesystem cannot enforce verity.
        arg = struct.pack('=IIIIQIIQ11Q', 1, 1, 0, 0, 0, 0, 0, 0, *([0] * 11))
        try:
            fcntl.ioctl(out, 0x40806685, arg)
        except OSError as exc:
            raise RestoreError('disk-backed fs-verity staging unavailable') from exc
        # Read the protected file completely after enabling verity, checking
        # both the kernel's verification and the independent SHA-256 digest.
        h = hashlib.sha256()
        while True:
            block = os.read(out, 1024 * 1024)
            if not block:
                break
            h.update(block)
        if h.hexdigest() != digest:
            raise RestoreError('verified staged archive digest mismatch')
        os.lseek(out, 0, os.SEEK_SET)
        os.unlink(name)
        name = None
        result, out = out, None
        return result
    finally:
        os.close(src)
        if out is not None:
            os.close(out)
        if name is not None:
            os.unlink(name)


def _validate_archive(fd):
    """Read every supported tar entry and reject ambiguous metadata or paths."""
    seen = {}
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        with os.fdopen(os.dup(fd), 'rb') as stream, tarfile.open(fileobj=stream, mode='r:') as tar:
            for member in tar:
                name = member.name
                if name == '.':
                    parts = []
                else:
                    if name.startswith('./'):
                        name = name[2:]
                    parts = name.split('/')
                    if name.startswith('/') or any(p in ('', '.', '..') for p in parts):
                        raise RestoreError('unsafe archive path')
                key = '/'.join(parts)
                if key in seen or not (member.isdir() or member.isfile()):
                    raise RestoreError('duplicate or unsupported archive entry')
                if any(seen.get('/'.join(parts[:i])) != 'directory' for i in range(len(parts))):
                    raise RestoreError('missing or non-directory parent')
                # This prototype cannot restore ACLs, xattrs, sparse data or
                # other unrecognised extensions. Reject them, not silently drop.
                if any(k not in ('path', 'mtime', 'atime', 'ctime', 'size', 'uid', 'gid', 'uname', 'gname')
                       for k in member.pax_headers) or member.sparse is not None:
                    raise RestoreError('unsupported archive metadata')
                if member.uid < 0 or member.gid < 0 or member.mode & ~0o7777:
                    raise RestoreError('unsupported ownership or mode')
                seen[key] = 'directory' if member.isdir() else 'file'
                if member.isfile():
                    source = tar.extractfile(member)
                    if source is None:
                        raise RestoreError('missing file contents')
                    with source:
                        remaining = member.size
                        while remaining:
                            data = source.read(min(1024 * 1024, remaining))
                            if not data:
                                raise RestoreError('truncated file contents')
                            remaining -= len(data)
        if seen.get('') != 'directory':
            raise RestoreError('missing archive root')
    except (tarfile.TarError, EOFError, OSError, ValueError) as exc:
        raise RestoreError('invalid archive') from exc
    finally:
        os.lseek(fd, 0, os.SEEK_SET)


def _inspect_all(runner, name, source):
    """Inspect exact volume and every container, including stopped containers."""
    volumes = local._json(runner, ['volume', 'inspect', name])
    if not isinstance(volumes, list) or len(volumes) != 1 or not isinstance(volumes[0], dict):
        raise RestoreError('invalid volume inspection')
    v = volumes[0]
    if (set(v) - {'CreatedAt', 'Driver', 'Labels', 'Mountpoint', 'Name', 'Options', 'Scope', 'Status', 'UsageData', 'ClusterVolume'}
            or v.get('Name') != name or v.get('Driver') != 'local' or v.get('Scope') != 'local'
            or v.get('Mountpoint') != source or v.get('Options') not in (None, {})
            or v.get('ClusterVolume') is not None):
        raise RestoreError('unsupported volume identity or topology')
    raw = runner(['ps', '--all', '--quiet', '--no-trunc'])
    try:
        ids = raw.decode('ascii').splitlines() if isinstance(raw, bytes) else raw.splitlines()
    except (UnicodeError, AttributeError) as exc:
        raise RestoreError('invalid container list') from exc
    if len(ids) != len(set(ids)) or any(not re.fullmatch('[0-9a-f]{64}', i) for i in ids):
        raise RestoreError('invalid container list')
    if not ids:
        return
    containers = local._json(runner, ['container', 'inspect', *ids])
    if not isinstance(containers, list) or len(containers) != len(ids):
        raise RestoreError('incomplete container inspection')
    found = set()
    for c in containers:
        if not isinstance(c, dict) or c.get('Id') not in ids or c['Id'] in found:
            raise RestoreError('invalid container inspection')
        found.add(c['Id'])
        state, host, mounts = c.get('State'), c.get('HostConfig'), c.get('Mounts')
        if not isinstance(state, dict) or not isinstance(host, dict) or not isinstance(mounts, list):
            raise RestoreError('missing container information')
        if not isinstance(state.get('Running'), bool) or not isinstance(state.get('Restarting'), bool):
            raise RestoreError('unknown container state')
        policy = host.get('RestartPolicy')
        if not isinstance(policy, dict) or policy.get('Name') not in ('no', 'always', 'unless-stopped', 'on-failure'):
            raise RestoreError('unknown restart policy')
        for mount in mounts:
            if not isinstance(mount, dict) or set(mount) - {'Type', 'Name', 'Source', 'Destination', 'Driver', 'Mode', 'RW', 'Propagation'}:
                raise RestoreError('unknown mount metadata')
            kind, path = mount.get('Type'), mount.get('Source')
            if kind not in ('bind', 'volume') or not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path:
                raise RestoreError('invalid mount')
            if kind == 'volume' and (not isinstance(mount.get('Name'), str) or not isinstance(mount.get('Driver'), str)):
                raise RestoreError('invalid volume mount')
            overlaps = local._overlap(path, source) or local._overlap(os.path.realpath(path), source)
            uses = overlaps or (kind == 'volume' and mount['Name'] == name)
            # Bind aliases are denied even when stopped: their restart and host
            # path semantics are not bounded by named-volume identity.
            if uses and (kind == 'bind' or state['Running'] or state['Restarting'] or policy['Name'] != 'no'):
                raise RestoreError('container can access or restart against volume')


def preflight(*, archive_path, trusted_sha256, workspace, volume_name, volume_root, runner, boundary_check):
    """Check synthetic input only; return no authority to modify a volume.

    The caller supplies a fake Docker runner. There is intentionally no live
    Docker adapter. No intent is persisted and no restore is performed.
    """
    if not isinstance(volume_name, str) or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', volume_name):
        raise RestoreError('invalid volume name')
    _guard(boundary_check)
    source = local._trusted_path(volume_root, volume_name, os.geteuid(), test_root=True)
    _inspect_all(runner, volume_name, source)
    fd = _stage_verity(archive_path, trusted_sha256, workspace)
    try:
        _validate_archive(fd)
        _guard(boundary_check)
        _inspect_all(runner, volume_name, source)
    finally:
        os.close(fd)
    return {'operational': False, 'restore_performed': False}


def restore(*args, **kwargs):
    raise RestoreError('restore disabled: durable retry intent, destructive step fencing, metadata preservation, and inventory verification are not implemented')
