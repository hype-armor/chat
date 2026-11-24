"""Experimental snapshots for the known read-only local Compose binds.

The caller must fence source changes and protect directory ancestry and all
same-UID processes. These helpers do not authorize runtime restoration.
"""
import base64
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile

import username_migration_blob_archive as blob_archive
import username_migration_blob_disk_snapshot as disk_snapshot
from username_migration_blob_tree import inventory


MAX_BIND_FILE = 64 * 1024 * 1024
MAX_BIND_TREE = 4 * 1024 * 1024 * 1024
MAX_BIND_ARCHIVE = 5 * 1024 * 1024 * 1024
MAX_BIND_ENTRIES = 100_000
MAX_BIND_PATH_DEPTH = 64
MAX_BIND_PATH_BYTES = 4096
MAX_BIND_XATTR_BYTES = 16 * 1024 * 1024
RESERVE_SPACE = 256 * 1024 * 1024


def _inventory_limits():
    return {'max_entries': MAX_BIND_ENTRIES, 'max_file_bytes': MAX_BIND_TREE,
            'max_path_depth': MAX_BIND_PATH_DEPTH, 'max_path_bytes': MAX_BIND_PATH_BYTES,
            'max_xattr_bytes': MAX_BIND_XATTR_BYTES}


class BindPolicyError(ValueError):
    """A mount is outside the supported local Compose policy."""


def validate_bind_mounts(config, compose_dir):
    """Return (service, volume index, source) for approved bind declarations.

    Source paths must be the exact absolute default paths. In particular, a
    CHAT_TILES_DIR override is not trusted. This is lexical validation only;
    a capture implementation must independently reject symlinks and races.
    """
    root = os.path.abspath(compose_dir)
    allowed = {
        ('web', '/etc/nginx/conf.d/extra/api-proxy.conf'): os.path.join(root, 'api-proxy.conf'),
        ('web', '/srv/tiles'): os.path.join(root, 'tiles'),
        ('https', '/etc/caddy/Caddyfile'): os.path.join(root, 'Caddyfile'),
    }
    try:
        services = config['services']
        if not isinstance(services, dict):
            raise BindPolicyError('Invalid services')
        result = []
        seen = set()
        for service, spec in services.items():
            if not isinstance(spec, dict) or not isinstance(spec.get('volumes', []), list):
                raise BindPolicyError('Invalid volumes')
            for index, volume in enumerate(spec.get('volumes', [])):
                if not isinstance(volume, dict):
                    raise BindPolicyError('Unknown volume syntax')
                kind = volume.get('type')
                if kind == 'volume':
                    continue
                if kind != 'bind':
                    raise BindPolicyError('Unknown mount type')
                if set(volume) - {'type', 'source', 'target', 'read_only', 'bind'}:
                    raise BindPolicyError('Unknown bind options')
                bind = volume.get('bind', {})
                if not isinstance(bind, dict) or set(bind) - {'create_host_path'}:
                    raise BindPolicyError('Unknown bind options')
                if 'create_host_path' in bind and type(bind['create_host_path']) is not bool:
                    raise BindPolicyError('Invalid bind option')
                target, source = volume.get('target'), volume.get('source')
                if not isinstance(target, str) or not isinstance(source, str):
                    raise BindPolicyError('Invalid bind source or target')
                key = (service, target)
                if volume.get('read_only') is not True or key not in allowed or source != allowed[key] or key in seen:
                    raise BindPolicyError('Bind is not an approved read-only local mount')
                seen.add(key)
                result.append((service, index, source))
        return result
    except (KeyError, TypeError, AttributeError):
        raise BindPolicyError('Invalid Compose configuration') from None


def _open_without_symlinks(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise BindPolicyError('Invalid source path')
    parts = path.split('/')[1:]
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            if index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            new = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except BaseException:
        os.close(fd)
        raise


def _copy_file(source, target):
    source_fd = _open_without_symlinks(source)
    target_fd = None
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_mode & 0o7000:
            raise BindPolicyError('Unsupported bind file')
        if before.st_size > MAX_BIND_FILE or shutil.disk_usage(os.path.dirname(target)).free < before.st_size + RESERVE_SPACE:
            raise BindPolicyError('Bind file size or free space is unsupported')
        if os.geteuid() != 0 and (before.st_uid != os.geteuid() or before.st_gid != os.getegid()):
            raise BindPolicyError('Cannot preserve bind file ownership')
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        digest = hashlib.sha256()
        while True:
            data = os.read(source_fd, 1024 * 1024)
            if not data:
                break
            digest.update(data)
            view = memoryview(data)
            while view:
                written = os.write(target_fd, view)
                if written <= 0:
                    raise OSError('short bind snapshot write')
                view = view[written:]
        if os.geteuid() == 0:
            os.fchown(target_fd, before.st_uid, before.st_gid)
        os.fchmod(target_fd, stat.S_IMODE(before.st_mode))
        attributes = []
        for name in sorted(os.listxattr(source_fd)):
            value = os.getxattr(source_fd, name)
            os.setxattr(target_fd, name, value)
            attributes.append([base64.b64encode(os.fsencode(name)).decode('ascii'),
                               base64.b64encode(value).decode('ascii')])
        os.utime(target_fd, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.fsync(target_fd)
        after = os.fstat(source_fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mode, s.st_uid, s.st_gid, s.st_mtime_ns, s.st_ctime_ns)
        if identity(before) != identity(after):
            raise BindPolicyError('Bind file changed during snapshot')
        return {'type': 'file', 'sha256': digest.hexdigest(), 'mode': stat.S_IMODE(before.st_mode),
                'uid': before.st_uid, 'gid': before.st_gid, 'size': before.st_size,
                'mtime_ns': before.st_mtime_ns, 'xattrs': attributes}
    finally:
        if target_fd is not None:
            os.close(target_fd)
        os.close(source_fd)


def snapshot_bind_mounts(config, compose_dir, output_dir):
    """Snapshot approved read-only binds and return rewritten config + evidence.

    output_dir must not exist. Its parent must be private and trusted. The
    returned paths and evidence are not durable authorization. Directory source
    snapshots reject links, special files, and unsupported metadata. They use
    bounded disk-backed preflight; the caller must fence all source writers.
    """
    declarations = validate_bind_mounts(config, compose_dir)
    parent = os.path.dirname(os.path.abspath(output_dir))
    parent_info = os.lstat(parent)
    if (not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.geteuid()
            or stat.S_IMODE(parent_info.st_mode) != 0o700):
        raise BindPolicyError('Snapshot parent must be private and owned')
    rewritten = json.loads(json.dumps(config))
    os.mkdir(output_dir, 0o700)
    records = []
    for index, (service, volume_index, source) in enumerate(declarations):
        target = os.path.join(os.path.abspath(output_dir), 'bind_' + str(index))
        fd = _open_without_symlinks(source)
        try:
            info = os.fstat(fd)
            kind = info.st_mode
        finally:
            os.close(fd)
        if stat.S_ISREG(kind):
            record = _copy_file(source, target)
        elif stat.S_ISDIR(kind):
            before = inventory(source, **_inventory_limits())
            total = sum(item['size'] for item in before['entries'] if item['type'] == 'file')
            if (total > MAX_BIND_TREE or len(before['entries']) > MAX_BIND_ENTRIES
                    or before['hardlinks'] or any(item['type'] not in ('file', 'directory')
                                                   for item in before['entries'])
                    or shutil.disk_usage(output_dir).free < total * 3 + RESERVE_SPACE):
                raise BindPolicyError('Bind tree size, entries, links or free space is unsupported')
            archive = blob_archive.capture(source, output_dir, 'pending_archive_' + str(index),
                                           max_archive_size=MAX_BIND_ARCHIVE,
                                           inventory_limits=_inventory_limits())
            digest = hashlib.sha256()
            with open(archive, 'rb') as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
            archive_size = os.stat(archive, follow_symlinks=False).st_size
            if (archive_size > MAX_BIND_ARCHIVE
                    or shutil.disk_usage(output_dir).free < archive_size + total + RESERVE_SPACE):
                raise BindPolicyError('Bind archive size or free space is unsupported')
            snapshot_fd = disk_snapshot.snapshot_and_validate(
                archive, digest.hexdigest(), output_dir,
                max_archive_size=MAX_BIND_ARCHIVE, max_entries=MAX_BIND_ENTRIES)
            staged = None
            staged_info = None
            try:
                staged = tempfile.mkdtemp(prefix='disposable-bind-', dir=output_dir)
                staged_info = os.lstat(staged)
                result = subprocess.run(['tar', '--extract', '--file', '-', '--acls', '--xattrs',
                                         '--xattrs-include=*', '--numeric-owner', '--same-owner',
                                         '--same-permissions', '--directory', staged], stdin=snapshot_fd,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                current = os.lstat(staged)
                if ((current.st_dev, current.st_ino) != (staged_info.st_dev, staged_info.st_ino)
                        or not stat.S_ISDIR(current.st_mode)):
                    staged = None
                    raise BindPolicyError('Disposable bind directory changed')
                if (result.returncode or inventory(staged, **_inventory_limits()) != before
                        or inventory(source, **_inventory_limits()) != before):
                    raise BindPolicyError('Bind directory verification failed')
                os.rename(staged, target)
                staged = None
            finally:
                os.close(snapshot_fd)
                if staged is not None and staged_info is not None:
                    try:
                        current = os.lstat(staged)
                        if (stat.S_ISDIR(current.st_mode) and
                                (current.st_dev, current.st_ino) == (staged_info.st_dev, staged_info.st_ino)):
                            shutil.rmtree(staged)
                    except FileNotFoundError:
                        pass
            os.unlink(archive)
            record = {'type': 'directory', 'inventory': before}
        else:
            raise BindPolicyError('Unsupported bind source')
        after_fd = _open_without_symlinks(source)
        try:
            after = os.fstat(after_fd)
            if (info.st_dev, info.st_ino) != (after.st_dev, after.st_ino):
                raise BindPolicyError('Bind source identity changed during snapshot')
        finally:
            os.close(after_fd)
        rewritten['services'][service]['volumes'][volume_index]['source'] = target
        records.append({'service': service, 'index': volume_index, 'source': source,
                        'source_identity': {'device': info.st_dev, 'inode': info.st_ino},
                        'snapshot': target, 'content': record})
    dfd = os.open(output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
    pfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(pfd)
    finally:
        os.close(pfd)
    return rewritten, records


def verify_bind_snapshots(records, output_dir):
    """Recheck caller-anchored snapshot evidence; this does not authorize restore."""
    for index, record in enumerate(records):
        path = os.path.join(os.path.abspath(output_dir), 'bind_' + str(index))
        source = record.get('source')
        source_identity = record.get('source_identity')
        if (record.get('snapshot') != path or not isinstance(record.get('content'), dict)
                or not isinstance(source, str) or not os.path.isabs(source) or os.path.normpath(source) != source
                or not isinstance(source_identity, dict) or set(source_identity) != {'device', 'inode'}
                or any(type(source_identity[k]) is not int or source_identity[k] < 0 for k in source_identity)):
            raise BindPolicyError('Bind evidence mismatch')
        expected = record['content']
        if expected.get('type') == 'directory':
            if inventory(path, **_inventory_limits()) != expected.get('inventory'):
                raise BindPolicyError('Bind directory changed')
        elif expected.get('type') == 'file':
            fd = _open_without_symlinks(path)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise BindPolicyError('Unsafe snapshot file')
                digest = hashlib.sha256()
                while True:
                    chunk = os.read(fd, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                attrs = [[base64.b64encode(os.fsencode(name)).decode('ascii'),
                          base64.b64encode(os.getxattr(fd, name)).decode('ascii')]
                         for name in sorted(os.listxattr(fd))]
                actual = {'type': 'file', 'sha256': digest.hexdigest(), 'mode': stat.S_IMODE(info.st_mode),
                          'uid': info.st_uid, 'gid': info.st_gid, 'size': info.st_size,
                          'mtime_ns': info.st_mtime_ns, 'xattrs': attrs}
                if actual != expected:
                    raise BindPolicyError('Bind file changed')
            finally:
                os.close(fd)
        else:
            raise BindPolicyError('Invalid bind evidence')
    return True
