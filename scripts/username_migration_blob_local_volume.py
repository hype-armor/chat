#!/usr/bin/env python3
"""Experimental local-volume capture; this does not enable the migration gate.

The caller must hold a durable external writer and container restart fence for
this entire operation. Host access by administrators or the same UID, and Docker
restart races, are not resolved by inspection. Do not use this as a production
recovery guarantee.
"""
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess

import username_migration_blob_archive as archive
import username_migration_blob_disk_snapshot as snapshot


class VolumeError(Exception):
    pass


def _docker(args):
    env = os.environ.copy()
    env.pop('DOCKER_HOST', None)
    env.pop('DOCKER_CONTEXT', None)
    result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *args],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            check=False)
    if result.returncode:
        raise VolumeError('Docker inspection failed')
    return result.stdout


def _json(runner, args):
    try:
        return json.loads(runner(args))
    except (ValueError, TypeError) as exc:
        raise VolumeError('invalid Docker inspection output') from exc


def _trusted_path(root, name, owner, *, test_root=False):
    path = os.path.join(root, name, '_data')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        current = ''
        for part in path.split('/')[1:]:
            if not part or part in ('.', '..'):
                raise VolumeError('invalid volume path')
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
            current += '/' + part
            st = os.fstat(fd)
            if (not test_root or current == root or current.startswith(root + '/')) and (st.st_uid != owner or st.st_mode & 0o022):
                raise VolumeError('volume path must be owned and not group/world writable')
        return path
    except OSError as exc:
        raise VolumeError('cannot securely open volume path') from exc
    finally:
        os.close(fd)


def _overlap(a, b):
    return os.path.commonpath((a, b)) in (a, b)


def _inspect(runner, name, source):
    volumes = _json(runner, ['volume', 'inspect', name])
    if not isinstance(volumes, list) or len(volumes) != 1 or not isinstance(volumes[0], dict):
        raise VolumeError('unexpected volume inspection')
    volume = volumes[0]
    # Docker may add metadata fields; only these documented fields are accepted.
    if set(volume) - {'CreatedAt', 'Driver', 'Labels', 'Mountpoint', 'Name', 'Options', 'Scope', 'Status', 'UsageData', 'ClusterVolume'}:
        raise VolumeError('unknown volume metadata')
    if (volume.get('Name') != name or volume.get('Driver') != 'local'
            or volume.get('Scope') != 'local' or volume.get('Mountpoint') != source
            or volume.get('Options') not in (None, {}) or volume.get('ClusterVolume') is not None):
        raise VolumeError('unsupported volume topology')
    raw = runner(['ps', '--quiet', '--no-trunc'])
    try:
        ids = raw.decode('ascii').splitlines() if isinstance(raw, bytes) else raw.splitlines()
    except (UnicodeError, AttributeError) as exc:
        raise VolumeError('invalid container list') from exc
    if any(not re.fullmatch(r'[0-9a-f]{64}', ident) for ident in ids) or len(set(ids)) != len(ids):
        raise VolumeError('invalid container list')
    if not ids:
        return
    containers = _json(runner, ['container', 'inspect', *ids])
    if not isinstance(containers, list) or len(containers) != len(ids):
        raise VolumeError('incomplete container inspection')
    seen = set()
    for container in containers:
        if not isinstance(container, dict) or container.get('Id') not in ids or container.get('Id') in seen:
            raise VolumeError('unexpected container inspection')
        seen.add(container['Id'])
        if not isinstance(container.get('State'), dict) or container['State'].get('Running') is not True:
            raise VolumeError('container state changed during inspection')
        mounts = container.get('Mounts')
        if not isinstance(mounts, list):
            raise VolumeError('missing container mounts')
        for mount in mounts:
            if not isinstance(mount, dict) or set(mount) - {'Type', 'Name', 'Source', 'Destination', 'Driver', 'Mode', 'RW', 'Propagation'}:
                raise VolumeError('unknown mount metadata')
            kind = mount.get('Type')
            if kind not in ('volume', 'bind'):
                raise VolumeError('unsupported mount type')
            path = mount.get('Source')
            if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path:
                raise VolumeError('invalid mount source')
            # Resolve existing path aliases as well as comparing the lexical path.
            if _overlap(path, source) or _overlap(os.path.realpath(path), source):
                raise VolumeError('active container can access volume')
            if kind == 'volume' and (not isinstance(mount.get('Name'), str) or not isinstance(mount.get('Driver'), str)):
                raise VolumeError('incomplete volume mount')
            if kind == 'volume' and mount['Name'] == name:
                raise VolumeError('active container mounts volume')


def _capture(name, workspace, output_name, *, root, runner, owner, max_archive_size,
             max_entries, max_file_bytes, max_path_depth, max_path_bytes,
             max_xattr_bytes, test_root=False):
    limits = {'max_entries': max_entries, 'max_file_bytes': max_file_bytes,
              'max_path_depth': max_path_depth, 'max_path_bytes': max_path_bytes,
              'max_xattr_bytes': max_xattr_bytes}
    if (type(max_archive_size) is not int or max_archive_size <= 0
            or type(max_entries) is not int or max_entries <= 0
            or any(type(v) is not int or v < 0 for v in limits.values())):
        raise VolumeError('explicit finite nonnegative limits are required; archive and entries must be positive')
    if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', name):
        raise VolumeError('invalid volume name')
    workspace = archive._private_directory(workspace)
    if not isinstance(output_name, str) or not output_name or output_name in ('.', '..') or os.path.basename(output_name) != output_name:
        raise VolumeError('invalid archive name')
    source = _trusted_path(root, name, owner, test_root=test_root)
    _inspect(runner, name, source)
    pending = '.volume-pending-' + secrets.token_hex(16)
    pending_path = os.path.join(workspace, pending)
    output = os.path.join(workspace, output_name)
    linked = False
    try:
        # This is a conservative check, not a reservation. Other writers and
        # filesystem metadata can still exhaust space at any time.
        fs = os.statvfs(workspace)
        if fs.f_bavail * fs.f_frsize < 2 * max_archive_size + max_file_bytes:
            raise VolumeError('insufficient workspace space for bounded capture')
        archive.capture(source, workspace, pending, max_archive_size=max_archive_size,
                        inventory_limits=limits)
        # Validate a disk-backed anonymous copy before publication.
        digest = hashlib.sha256()
        with open(pending_path, 'rb') as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        fs = os.statvfs(workspace)
        if fs.f_bavail * fs.f_frsize < os.stat(pending_path, follow_symlinks=False).st_size:
            raise VolumeError('insufficient workspace space for snapshot')
        verified = snapshot.snapshot_and_validate(pending_path, digest.hexdigest(), workspace,
                                                  max_archive_size=max_archive_size,
                                                  max_entries=max_entries)
        os.close(verified)
        _trusted_path(root, name, owner, test_root=test_root)
        _inspect(runner, name, source)
        os.link(pending_path, output, follow_symlinks=False)
        linked = True
        fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
            os.unlink(pending_path)
            os.fsync(fd)
        finally:
            os.close(fd)
        return output
    except Exception:
        if linked:
            os.unlink(output)
        raise
    finally:
        if os.path.lexists(pending_path):
            os.unlink(pending_path)


def capture(name, workspace, output_name, *, max_archive_size, max_entries,
            max_file_bytes, max_path_depth, max_path_bytes, max_xattr_bytes):
    """Capture with explicit limits; this does not authorize operational restore.

    Trusted administrators must protect source, workspace, and digest from
    privileged and same-UID writers. The caller must hold the external writer
    and container restart fence throughout. Space checks are not reservations.
    """
    return _capture(name, workspace, output_name, root='/var/lib/docker/volumes',
                    runner=_docker, owner=0, max_archive_size=max_archive_size,
                    max_entries=max_entries, max_file_bytes=max_file_bytes,
                    max_path_depth=max_path_depth, max_path_bytes=max_path_bytes,
                    max_xattr_bytes=max_xattr_bytes)
