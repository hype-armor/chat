"""Experimental PostgreSQL capture primitive; NOT a rollback adapter.

This module does not establish writer fencing, capture cluster globals, or prove
complete recovery. Its output must never authorize a migration or rollback.
The caller must supply a trusted local maintenance socket and a private directory.
"""
import os
import re
import stat
import subprocess


class RecoveryUnavailable(RuntimeError):
    pass


_NAME = re.compile(r'[A-Za-z_][A-Za-z_0-9]{0,62}\Z')


def capture_database(*, bindir, socket, port, user, database, directory, name, library_path=None):
    """Capture one custom-format dump, without claiming that it is recoverable.

    The trusted socket, server identity, writer fence, binaries and directory
    ancestry are caller guarantees. This operation does not connect over TCP.
    Archive decoding is only a structural check, not a restore.
    """
    if not all(_NAME.fullmatch(x) for x in (user, database, name)):
        raise ValueError('invalid user, database or archive name')
    if not os.path.isabs(socket) or not os.path.isabs(bindir):
        raise ValueError('absolute local socket and binary directory required')
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError('invalid port')
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    temp = None
    try:
        info = os.fstat(dfd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('archive directory must be private and owned by caller')
        # No inherited PG* settings, service files, or password files. Only a
        # trusted local maintenance endpoint with independently arranged auth.
        env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
               'PGHOST': socket, 'PGPORT': str(port), 'PGUSER': user,
               'PGDATABASE': database, 'PGCONNECT_TIMEOUT': '5'}
        if library_path is not None:
            env['LD_LIBRARY_PATH'] = library_path
        # Name is random and opened exclusively in the held private directory.
        import secrets
        temp = '.capture-' + secrets.token_hex(16)
        fd = os.open(temp, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        try:
            subprocess.run([os.path.join(bindir, 'pg_dump'), '--no-password', '--format=custom'],
                           env=env, stdout=fd, stderr=subprocess.DEVNULL, check=True)
            if os.fstat(fd).st_size == 0:
                raise ValueError('empty dump')
            os.fsync(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            subprocess.run([os.path.join(bindir, 'pg_restore'), '--list'], env=env,
                           stdin=fd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            # The table of contents can survive even if a data block is damaged.
            # Read and decompress all entries before publication. This is not a
            # database restore and does not prove that the SQL will execute.
            os.lseek(fd, 0, os.SEEK_SET)
            subprocess.run([os.path.join(bindir, 'pg_restore'), '--file=-'], env=env,
                           stdin=fd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        finally:
            os.close(fd)
        # Hard-link publication is atomic and fails if the destination exists.
        os.link(temp, name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
        os.fsync(dfd)
    finally:
        if temp is not None:
            try:
                os.unlink(temp, dir_fd=dfd)
                os.fsync(dfd)
            except FileNotFoundError:
                pass
        os.close(dfd)


def verify_database_restore(*, bindir, socket, port, user, directory, name, library_path=None):
    """Restore an archive to a new database on a caller-isolated test cluster.

    The caller must independently establish that the target is a disposable,
    network-isolated cluster of a compatible version. Archive SQL is executable
    and must come from a trusted source. This check preserves ownership and ACLs,
    and fails if their roles are missing. It does not restore cluster globals or
    prove that production recovery is safe. It never targets a live database.
    """
    import secrets
    if not _NAME.fullmatch(user) or not _NAME.fullmatch(name):
        raise ValueError('invalid user or archive name')
    if not os.path.isabs(socket) or not os.path.isabs(bindir):
        raise ValueError('absolute local socket and binary directory required')
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError('invalid port')
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    created = False
    temporary_db = 'chat_verify_' + secrets.token_hex(16)
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
           'PGHOST': socket, 'PGPORT': str(port), 'PGUSER': user,
           'PGDATABASE': 'postgres', 'PGCONNECT_TIMEOUT': '5'}
    if library_path is not None:
        env['LD_LIBRARY_PATH'] = library_path
    try:
        info = os.fstat(dfd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('archive directory must be private and owned by caller')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dfd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size == 0):
            raise ValueError('archive must be a private regular file')
        # Create a fresh random database, never restore into an existing one.
        subprocess.run([os.path.join(bindir, 'createdb'), '--no-password', '--template=template0', temporary_db],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=60)
        created = True
        subprocess.run([os.path.join(bindir, 'pg_restore'), '--exit-on-error', '--single-transaction',
                        '--no-password', '--dbname', temporary_db], env=env, stdin=fd,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=600)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(dfd)
        if created:
            # A failed cleanup is a failure, not a successful verification.
            subprocess.run([os.path.join(bindir, 'dropdb'), '--no-password', '--if-exists', temporary_db],
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=60)


def restore_database(*args, **kwargs):
    """Fail closed until scoped globals, fencing and rollback are implemented."""
    raise RecoveryUnavailable('rollback unavailable: globals, scope validation, fencing and automatic restore are not implemented')
