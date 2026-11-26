#!/usr/bin/env bash
# EXPERIMENTAL ONLY: not a deployment or full recovery procedure.
exec python3 - "$@" <<'PY'
import ctypes
import os
import re
import secrets
import signal
import stat
import subprocess
import sys

os.umask(0o077)
if len(sys.argv) != 3 or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', sys.argv[1]) or not os.path.isabs(sys.argv[2]):
    sys.exit('Usage: bash experimental-pg-backup-validate.sh POSTGRES_CONTAINER ABSOLUTE_NEW_BACKUP_PATH')
container, backup = sys.argv[1:]
image = os.environ.get('VALIDATION_IMAGE', '')
if not all(os.environ.get(x) for x in ('PGUSER', 'PGDATABASE', 'PGPASSWORD')) or not re.search(r'@sha256:[0-9a-f]{64}$', image):
    sys.exit('Set PostgreSQL environment variables and a digest-pinned VALIDATION_IMAGE.')
parent, name = os.path.split(backup)
if name in ('', '.', '..'):
    sys.exit('Invalid backup name.')

# Open every directory component without following symlinks. Keep the final
# directory descriptor for all operations, including publication.
def open_dir(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.split('/'):
            if not component or component == '.':
                continue
            if component == '..':
                raise ValueError('Parent traversal is not allowed')
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def call(args, **kwargs):
    # Docker diagnostics can contain credentials. Do not log them.
    subprocess.run(['docker', *args], check=True, stdout=kwargs.pop('stdout', subprocess.DEVNULL),
                   stderr=subprocess.DEVNULL, **kwargs)

def interrupt(signum, frame):
    raise InterruptedError('Interrupted')

signal.signal(signal.SIGTERM, interrupt)
validate = 'chat-restore-check-' + secrets.token_hex(12)
dirfd = fd = None
started = published = False
failed = False
try:
    dirfd = open_dir(parent)
    st = os.fstat(dirfd)
    if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError('Backup directory must be owned by this user and mode 700')
    # An unnamed inode cannot be replaced or opened through a pathname. Fail
    # closed when the filesystem does not support O_TMPFILE or linkat.
    fd = os.open('.', os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=dirfd)
    call(['exec', '-e', 'PGUSER', '-e', 'PGDATABASE', '-e', 'PGPASSWORD', container,
          'pg_dump', '-h', '127.0.0.1', '-Fc'], stdout=fd)
    if os.fstat(fd).st_size == 0:
        raise ValueError('Backup is empty')
    os.fsync(fd)
    call(['image', 'inspect', image])
    # A failed run can still create a container. Always attempt removal.
    started = True
    call(['run', '-d', '--pull=never', '--name', validate, '--network', 'none',
          '-e', 'POSTGRES_PASSWORD=unused', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image])
    import time
    for _ in range(60):
        try:
            call(['exec', validate, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'])
            break
        except subprocess.CalledProcessError:
            time.sleep(1)
    else:
        raise ValueError('Validation PostgreSQL did not become ready')
    os.lseek(fd, 0, os.SEEK_SET)
    call(['exec', '-i', validate, 'pg_restore', '-h', '127.0.0.1', '-U', 'postgres',
          '-d', 'postgres', '--exit-on-error', '--no-owner', '--no-privileges'], stdin=fd)
    call(['rm', '-f', validate])
    started = False
    # Detect directory path replacement before publishing. The directory must
    # remain trusted and private for the entire operation, including afterwards.
    checkfd = open_dir(parent)
    try:
        current = os.fstat(checkfd)
        original = os.fstat(dirfd)
        if (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino) or current.st_uid != os.geteuid() or stat.S_IMODE(current.st_mode) != 0o700:
            raise ValueError('Backup directory changed')
    finally:
        os.close(checkfd)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.linkat(fd, ctypes.c_char_p(b''), dirfd, os.fsencode(name), 0x1000) != 0:
        err = ctypes.get_errno()
        # AT_EMPTY_PATH can require a capability. Linux procfs provides a
        # reference to the same still-open inode without that capability.
        if err not in (1, 2):
            raise OSError(err, os.strerror(err))
        procpath = os.fsencode('/proc/self/fd/' + str(fd))
        procstat = os.stat(procpath)
        filestat = os.fstat(fd)
        if (procstat.st_dev, procstat.st_ino) != (filestat.st_dev, filestat.st_ino):
            raise ValueError('File descriptor reference changed')
        if libc.linkat(-100, procpath, dirfd, os.fsencode(name), 0x400) != 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
    published = True
    os.fsync(dirfd)
    print('Verified limited data-only restore; archive published:', backup)
    print('NOT full recovery: globals, ownership, ACLs, credentials, blobs and writer fencing are excluded.', file=sys.stderr)
except (Exception, KeyboardInterrupt) as exc:
    failed = True
    print('UNVERIFIED: backup or validation failed; no full recovery claim.', file=sys.stderr)
    print('Failure type:', type(exc).__name__, file=sys.stderr)
    if published:
        # Publication happened but directory durability is uncertain. Leave the
        # archive intact rather than risk deleting a replacement inode.
        print('Published archive durability is uncertain; treat it as UNVERIFIED:', backup, file=sys.stderr)
finally:
    if started:
        try:
            call(['rm', '-f', validate])
        except Exception:
            failed = True
            print('Validation container cleanup failed; remove manually:', validate, file=sys.stderr)
    if fd is not None:
        os.close(fd)
    if dirfd is not None:
        os.close(dirfd)
sys.exit(1 if failed else 0)
PY
