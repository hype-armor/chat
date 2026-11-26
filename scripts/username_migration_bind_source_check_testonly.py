"""Experimental source recheck for independently authenticated Compose bind records.

Call only after physical fencing. The caller must authenticate the complete manifest,
protect its snapshot and path ancestry, and stop all writers and same-UID/root
processes. This check does not fence writers or authorize backup or restore.
Self-consistent forged records cannot be detected without that external anchor.
"""
import base64
import hashlib
import os
import stat

from username_migration_blob_tree import inventory, signature
from username_migration_compose_binds import (
    BindPolicyError, MAX_BIND_FILE, _inventory_limits,
    _open_without_symlinks, verify_bind_snapshots,
)


def verify_sources(records, output_dir):
    """Compare every original source to its authenticated snapshot evidence.

    Records and output_dir must come from an independently verified, complete
    manifest, not from an untrusted caller. All paths must remain protected.
    Raises on failure; returns True only when all records match.
    """
    if not isinstance(records, list) or not isinstance(output_dir, str) or not os.path.isabs(output_dir) or os.path.normpath(output_dir) != output_dir:
        raise BindPolicyError('Invalid bind evidence')
    seen_keys, seen_sources = set(), set()
    try:
        for record in records:
            if not isinstance(record, dict) or set(record) != {'service', 'index', 'source', 'source_identity', 'snapshot', 'content'}:
                raise BindPolicyError('Invalid bind record')
            service, index, source = record['service'], record['index'], record['source']
            if (not isinstance(service, str) or not service or type(index) is not int or index < 0
                    or not isinstance(source, str) or not os.path.isabs(source)
                    or os.path.normpath(source) != source or source == '/'
                    or (service, index) in seen_keys or source in seen_sources):
                raise BindPolicyError('Invalid or duplicate bind record')
            seen_keys.add((service, index))
            seen_sources.add(source)
        # Verify the snapshot independently rather than trusting content fields alone.
        verify_bind_snapshots(records, output_dir)
        for record in records:
            source = record['source']
            fd = _open_without_symlinks(source)
            try:
                before = os.fstat(fd)
                if {'device': before.st_dev, 'inode': before.st_ino} != record['source_identity']:
                    raise BindPolicyError('Source identity changed')
                expected = record['content']
                if expected.get('type') == 'file':
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_mode & 0o7000 or before.st_size > MAX_BIND_FILE:
                        raise BindPolicyError('Unsupported source file')
                    digest = hashlib.sha256()
                    while True:
                        data = os.read(fd, 1024 * 1024)
                        if not data:
                            break
                        digest.update(data)
                    attrs = [[base64.b64encode(os.fsencode(name)).decode('ascii'),
                              base64.b64encode(os.getxattr(fd, name)).decode('ascii')]
                             for name in sorted(os.listxattr(fd))]
                    actual = {'type': 'file', 'sha256': digest.hexdigest(),
                              'mode': stat.S_IMODE(before.st_mode), 'uid': before.st_uid,
                              'gid': before.st_gid, 'size': before.st_size,
                              'mtime_ns': before.st_mtime_ns, 'xattrs': attrs}
                    if actual != expected or signature(os.fstat(fd)) != signature(before):
                        raise BindPolicyError('Source file changed')
                elif expected.get('type') == 'directory':
                    if not stat.S_ISDIR(before.st_mode):
                        raise BindPolicyError('Unsupported source directory')
                    actual = inventory(source, **_inventory_limits())
                    if actual != expected.get('inventory') or actual['hardlinks']:
                        raise BindPolicyError('Source directory changed')
                    for entry in actual['entries']:
                        if entry['type'] not in ('file', 'directory'):
                            raise BindPolicyError('Unsupported source entry')
                        if entry['type'] == 'file':
                            relative = base64.b64decode(entry['path'], validate=True)
                            path = os.path.join(os.fsencode(source), relative)
                            child = _open_without_symlinks(os.fsdecode(path))
                            try:
                                if not stat.S_ISREG(os.fstat(child).st_mode) or os.fstat(child).st_nlink != 1:
                                    raise BindPolicyError('Unsupported source link')
                            finally:
                                os.close(child)
                    if signature(os.fstat(fd)) != signature(before):
                        raise BindPolicyError('Source directory changed during scan')
                else:
                    raise BindPolicyError('Invalid bind content')
                check = _open_without_symlinks(source)
                try:
                    if signature(os.fstat(check)) != signature(before):
                        raise BindPolicyError('Source path changed during scan')
                finally:
                    os.close(check)
            finally:
                os.close(fd)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        if isinstance(exc, BindPolicyError):
            raise
        raise BindPolicyError('Cannot verify bind source') from exc
    return True
