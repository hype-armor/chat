#!/usr/bin/env python3
"""Experimental offline archive for trusted synthetic trees, not production recovery.

The caller must fence all writers and protect the source and private workspace.
This module does not establish Docker volume isolation or defend against root or
same-UID processes that modify paths concurrently.
"""
import os
import selectors
import stat
import subprocess
import tempfile

from username_migration_blob_tree import inventory


class ArchiveError(Exception):
    pass


def _private_directory(path):
    path = os.path.abspath(os.fspath(path))
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise ArchiveError('workspace must be an owned private directory, not a symlink')
    return path


def _tar(*args):
    result = subprocess.run(['tar', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise ArchiveError('tar failed: ' + result.stderr.decode(errors='replace'))
    return result.stdout


def _create_bounded_archive(source, path, limit):
    """Stream tar output to disk without writing more than limit bytes."""
    with open(path, 'xb', buffering=0) as output:
        process = subprocess.Popen(
            ['tar', '--create', '--file', '-', '--format=pax', '--acls', '--xattrs',
             '--xattrs-include=*', '--numeric-owner', '--directory', source, '.'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            written = 0
            errors = bytearray()
            truncated = False
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                selector.register(process.stderr, selectors.EVENT_READ)
                while selector.get_map():
                    for key, _ in selector.select():
                        is_error = key.fileobj is process.stderr
                        size = 65536 if is_error else min(65536, limit - written + 1)
                        chunk = os.read(key.fd, size)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        if is_error:
                            remaining = 65536 - len(errors)
                            errors.extend(chunk[:remaining])
                            truncated |= len(chunk) > remaining
                            continue
                        if len(chunk) > limit - written:
                            raise ArchiveError('archive exceeds hard write limit')
                        view = memoryview(chunk)
                        while view:
                            count = output.write(view)
                            if not count:
                                raise OSError('archive write made no progress')
                            view = view[count:]
                        written += len(chunk)
            if process.wait() != 0:
                diagnostic = errors.decode(errors='replace')
                if truncated:
                    diagnostic += ' [stderr truncated]'
                raise ArchiveError('tar failed: ' + diagnostic)
        finally:
            if process.poll() is None:
                process.kill()
            process.stdout.close()
            process.stderr.close()
            process.wait()


def _extract_bounded(*args):
    """Extract without retaining stdout or more than 64 KiB of stderr."""
    process = subprocess.Popen(['tar', *args], stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE)
    try:
        errors = bytearray()
        truncated = False
        while True:
            chunk = os.read(process.stderr.fileno(), 65536)
            if not chunk:
                break
            remaining = 65536 - len(errors)
            errors.extend(chunk[:remaining])
            truncated |= len(chunk) > remaining
        if process.wait() != 0:
            diagnostic = errors.decode(errors='replace')
            if truncated:
                diagnostic += ' [stderr truncated]'
            raise ArchiveError('tar failed: ' + diagnostic)
    finally:
        if process.poll() is None:
            process.kill()
        process.stderr.close()
        process.wait()


def _check_tools():
    if b'GNU tar' not in _tar('--version'):
        raise ArchiveError('GNU tar is required')
    help_text = _tar('--help')
    for option in (b'--xattrs', b'--acls', b'--numeric-owner', b'--xattrs-include'):
        if option not in help_text:
            raise ArchiveError('tar lacks required metadata support')


def _probe_xattrs(work):
    probe = os.path.join(work, 'xattr-probe')
    with open(probe, 'xb'):
        pass
    try:
        os.setxattr(probe, 'user.blob_archive_probe', b'probe')
        if os.getxattr(probe, 'user.blob_archive_probe') != b'probe':
            raise ArchiveError('xattr probe mismatch')
    finally:
        os.unlink(probe)


def capture(source, workspace, name, *, max_archive_size=None, inventory_limits=None):
    """Publish name in workspace only after a verified fresh restore.

    Workspace must be private and on the target filesystem. No overwrite is
    permitted. Returns the archive path. Source writers must remain fenced.
    max_archive_size limits archive bytes written; it does not reserve space.
    inventory_limits, if supplied, contains keyword limits for every inventory.
    """
    if max_archive_size is not None and (type(max_archive_size) is not int or max_archive_size < 0):
        raise ArchiveError('invalid hard archive write limit')
    workspace = _private_directory(workspace)
    source = os.path.abspath(os.fspath(source))
    if not name or name in ('.', '..') or os.path.basename(name) != name:
        raise ArchiveError('archive name must be a single path component')
    if os.path.commonpath((source, workspace)) in (source, workspace):
        raise ArchiveError('source and workspace must be separate')
    output = os.path.join(workspace, name)
    if os.path.lexists(output):
        raise ArchiveError('archive already exists')
    limits = {} if inventory_limits is None else dict(inventory_limits)
    published = False
    try:
        _check_tools()
        with tempfile.TemporaryDirectory(prefix='.blob-archive-', dir=workspace) as work:
            os.chmod(work, 0o700)
            _probe_xattrs(work)
            before = inventory(source, **limits)
            if os.geteuid() != 0 and any(e['uid'] != os.geteuid() or e['gid'] != os.getegid() for e in before['entries']):
                raise ArchiveError('insufficient privileges to preserve numeric ownership')
            archive = os.path.join(work, 'snapshot.tar')
            restore = os.path.join(work, 'restore')
            os.mkdir(restore, 0o700)
            if max_archive_size is None:
                _tar('--create', '--file', archive, '--format=pax', '--acls', '--xattrs',
                     '--xattrs-include=*', '--numeric-owner', '--directory', source, '.')
            else:
                _create_bounded_archive(source, archive, max_archive_size)
            os.chmod(archive, 0o600)
            with open(archive, 'rb') as stream:
                os.fsync(stream.fileno())
            _extract_bounded('--extract', '--file', archive, '--acls', '--xattrs', '--xattrs-include=*',
                 '--numeric-owner', '--same-owner', '--same-permissions', '--directory', restore)
            if before != inventory(restore, **limits) or before != inventory(source, **limits):
                raise ArchiveError('source and restored trees differ')
            os.link(archive, output, follow_symlinks=False)
            published = True
            fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        return output
    except Exception as exc:
        if published:
            os.unlink(output)
        if isinstance(exc, ArchiveError):
            raise
        raise ArchiveError('archive failed: ' + str(exc)) from exc
