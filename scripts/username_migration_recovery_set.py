#!/usr/bin/env python3
"""Experimental private inventory of externally captured recovery material.

This tool does not fence writers, capture PostgreSQL, snapshot SeaweedFS, verify
scope, or authorize a restore. Inputs and directory ownership must be trusted;
same-UID processes remain inside the trust boundary. A complete manifest means
only that the supplied files were copied. Never use it as migration approval.
"""
import argparse
import hashlib
import json
import os
import stat


class RecoverySetError(RuntimeError):
    pass


def _directory(path):
    """Open each directory component without following symlinks."""
    path = os.path.abspath(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.split('/')[1:]:
            if part:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd)
                fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_file(path):
    parent, name = os.path.split(os.path.abspath(path))
    dfd = _directory(parent)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    finally:
        os.close(dfd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise RecoverySetError('input must be a regular file with one link')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read()
        if not data:
            raise RecoverySetError('empty input')
        after = os.fstat(fd)
        if (st.st_size, st.st_mtime_ns, st.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RecoverySetError('input changed during capture')
        return data
    finally:
        os.close(fd)


def _publish(dfd, name, data):
    pending = '.' + name + '.pending'
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
    try:
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError('short write')
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.link(pending, name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
    os.unlink(pending, dir_fd=dfd)
    os.fsync(dfd)


def create(*, output, database_archive, postgres_globals, postgres_settings,
           compose_config, image_identifiers, environment, seaweed_inventory,
           blob_backup_required):
    """Copy caller-supplied captures into a new private directory.

    PostgreSQL inputs must be scoped by the caller. The settings capture must
    include role and database settings. The inventory must describe SeaweedFS
    volumes and consistency assumptions. None of these claims are verified.
    """
    if blob_backup_required:
        raise RecoverySetError('blob backup required: no atomic SeaweedFS snapshot adapter is supported')
    inputs = {'database.archive': database_archive, 'postgres-globals.sql': postgres_globals,
              'postgres-settings.json': postgres_settings, 'compose-resolved.json': compose_config,
              'image-identifiers.json': image_identifiers, 'environment.env': environment,
              'seaweedfs-inventory.json': seaweed_inventory}
    # Reject bad inputs before creating any output. JSON inputs remain private.
    captures = {name: _read_file(path) for name, path in inputs.items()}
    for name in ('postgres-settings.json', 'compose-resolved.json', 'image-identifiers.json', 'seaweedfs-inventory.json'):
        try:
            obj = json.loads(captures[name])
        except (ValueError, UnicodeError) as exc:
            raise RecoverySetError('invalid JSON: ' + name) from exc
        if not isinstance(obj, (dict, list)) or not obj:
            raise RecoverySetError('empty JSON inventory: ' + name)
    parent, name = os.path.split(os.path.abspath(output))
    if not name or name in ('.', '..'):
        raise RecoverySetError('invalid output directory')
    pfd = _directory(parent)
    dfd = None
    try:
        os.mkdir(name, 0o700, dir_fd=pfd)  # exclusive; never replace an existing path
        os.fsync(pfd)
        dfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=pfd)
        records = {}
        for filename, data in captures.items():
            _publish(dfd, filename, data)
            records[filename] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        manifest = {'version': 1, 'files': records, 'blob_backup': 'not captured',
                    'scope_verified': False, 'capture_consistency_verified': False,
                    'restore_authorized': False,
                    'warning': 'Evidence alone never authorizes restore. Incomplete directories have no manifest.'}
        _publish(dfd, 'manifest.json', (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode())
        os.fsync(pfd)
    finally:
        if dfd is not None:
            os.close(dfd)
        os.close(pfd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('output', 'database-archive', 'postgres-globals', 'postgres-settings',
                'compose-config', 'image-identifiers', 'environment', 'seaweed-inventory'):
        parser.add_argument('--' + arg, required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--blob-backup-required', action='store_true')
    group.add_argument('--blob-backup-not-required', action='store_true')
    args = vars(parser.parse_args())
    args.pop('blob_backup_not_required')
    try:
        create(**args)
    except (RecoverySetError, OSError) as exc:
        parser.exit(1, 'recovery set not completed: ' + str(exc) + '\n')


if __name__ == '__main__':
    main()
