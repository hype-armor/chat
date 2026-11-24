"""Experimental PostgreSQL credential rotation adapter; not an updater.

The caller must stop every container that mounts the PostgreSQL data volume,
keep them stopped, hold the deployment lock, and durably persist the new secret
before calling this module. Docker and host administrators are trusted. This
module is not an authorization to migrate or to start either server version.
It deliberately refuses unsupported configurations. It does not back up data.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import time


class RotationError(RuntimeError):
    pass


def _run(args, *, input=None):
    # SQL and Docker diagnostics can include credentials. Never echo them.
    return subprocess.run(args, input=input, text=True, capture_output=True,
                          check=True, timeout=120).stdout.strip()


def _journal(path, operation_id, name, image, volume, role, password):
    record = {'operation_id': operation_id, 'name': name, 'image': image, 'volume': volume,
              'role': role, 'credential_hash': hashlib.sha256(password.encode('ascii')).hexdigest()}
    # Keep all operations relative to one trusted, private directory descriptor.
    parent, filename = os.path.split(os.path.abspath(path))
    if filename in ('', '.', '..'):
        raise RotationError('invalid rotation journal path')
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RotationError('rotation journal directory must be private')
        try:
            fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        except FileExistsError:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, encoding='utf-8') as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                        or info.st_size > 4096 or json.load(stream) != record):
                    raise RotationError('rotation journal identity mismatch')
                os.fsync(stream.fileno())
        else:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(record, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
        os.fsync(directory)
    finally:
        os.close(directory)


def _find_verified(run, name, operation_id, image, volume):
    # Listing first distinguishes absence from an inspection or daemon error.
    names = run(['docker', 'ps', '-a', '--no-trunc', '--format', '{{.Names}}']).splitlines()
    if name not in names:
        return None
    details = json.loads(run(['docker', 'inspect', name]))
    if not isinstance(details, list) or len(details) != 1:
        raise RotationError('ambiguous container identity')
    item = details[0]
    cid = item['Id']
    mounts = item['Mounts']
    if (not re.fullmatch(r'[0-9a-f]{64}', cid)
            or item.get('Name') != '/' + name
            or item.get('Config', {}).get('Labels', {}).get('chat.rotation.operation') != operation_id
            or item['Image'] != image or item['HostConfig']['NetworkMode'] != 'none'
            or len(mounts) != 1
            or (mounts[0].get('Type'), mounts[0].get('Name'), mounts[0].get('Destination')) != ('volume', volume, '/var/lib/postgresql')):
        raise RotationError('ambiguous container identity')
    return cid


def rotate_isolated(image, volume, role, password, *, operation_id, journal_path, run=_run, sleep=time.sleep):
    """Rotate one role in a network-isolated copy of the existing server.

    `image` must be the immutable ID captured from the existing PostgreSQL
    container. `volume` must be its verified PostgreSQL 18 data volume. The
    caller is responsible for both facts and for preventing other deployers
    from starting a container against the volume. Existing role credentials
    must be captured separately for recovery before this function is invoked.
    A failed call can have rotated the password. Retry only with the same
    durably stored password and the same verified target. The caller must
    serialize attempts and protect the journal directory from other writers.
    Use the same operation ID and journal path on every retry. The journal
    stores no credentials. Volume checks do not provide exclusive access;
    the caller must hold an enforceable supervisor boundary throughout.
    """
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise RotationError('invalid pinned image ID')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', volume):
        raise RotationError('invalid Docker volume name')
    if not re.fullmatch(r'[a-z_][a-z_0-9]{0,62}', role):
        raise RotationError('invalid PostgreSQL role')
    if not re.fullmatch(r'[0-9a-f]{64}', password):
        raise RotationError('invalid rotation credential')

    if not re.fullmatch(r'[0-9a-f]{32}', operation_id):
        raise RotationError('invalid operation ID')
    name = 'chat-pg-fence-' + operation_id
    try:
        _journal(journal_path, operation_id, name, image, volume, role, password)
    except Exception:
        raise RotationError('rotation journal unavailable or mismatched') from None
    cid = None
    cleanup_error = None
    try:
        # A previous attempt may have created the container but lost its reply.
        previous = _find_verified(run, name, operation_id, image, volume)
        if previous:
            run(['docker', 'rm', '-f', previous])
        # This check is not a lock. A trusted supervisor must prevent a new
        # container from mounting the data volume after the check.
        if run(['docker', 'ps', '--filter', 'volume=' + volume,
                '--format', '{{.ID}}']):
            raise RotationError('PostgreSQL data volume is still in use')
        run(['docker', 'image', 'inspect', image])
        run(['docker', 'volume', 'inspect', volume])
        cid = run(['docker', 'create', '--pull=never', '--name', name,
                   '--label', 'chat.rotation.operation=' + operation_id, '--network', 'none', '--mount',
                   'type=volume,source=' + volume + ',target=/var/lib/postgresql', image,
                   'postgres', '-c', 'listen_addresses=', '-c', 'archive_mode=off',
                   '-c', 'shared_preload_libraries=', '-c', 'session_preload_libraries=',
                   '-c', 'local_preload_libraries=', '-c', 'log_statement=none',
                   '-c', 'log_min_error_statement=panic'])
        if not re.fullmatch(r'[0-9a-f]{64}', cid):
            raise RotationError('invalid created container ID')
        # Check the effective network and image before starting PostgreSQL.
        if _find_verified(run, name, operation_id, image, volume) != cid:
            raise RotationError('isolated container inspection failed')
        run(['docker', 'start', cid])
        for _ in range(60):
            try:
                run(['docker', 'exec', cid, 'pg_isready', '-U', role, '-d', 'postgres'])
                break
            except subprocess.CalledProcessError:
                sleep(1)
        else:
            raise RotationError('isolated PostgreSQL did not become ready')

        command = ['docker', 'exec', '-i', cid, 'psql', '-X', '-qAt', '-v',
                   'ON_ERROR_STOP=1', '-U', role, '-d', 'postgres']
        # pg_hba_file_rules includes includes. Only password authentication or
        # reject is acceptable on host connections. The role must be the only
        # LOGIN role, and prepared transactions cannot cross the fence.
        query = """SELECT json_build_object(
          'extra_logins', (SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname <> current_user),
          'prepared', (SELECT count(*) FROM pg_prepared_xacts),
          'bad_hba', (SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL OR (type LIKE 'host%' AND auth_method NOT IN ('scram-sha-256','md5','reject')) OR (type='local' AND auth_method NOT IN ('trust','reject'))),
          'extra_replication', (SELECT count(*) FROM pg_roles WHERE rolreplication AND rolname <> current_user),
          'preload', current_setting('shared_preload_libraries'),
          'superuser', (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
          'user', current_user,
          'port', current_setting('port'))::text;
        """
        checks = json.loads(run(command, input=query))
        if (checks.get('extra_logins') != 0 or checks.get('prepared') != 0
                or checks.get('bad_hba') != 0 or checks.get('extra_replication') != 0
                or checks.get('preload') != '' or checks.get('superuser') is not True
                or checks.get('user') != role):
            raise RotationError('unsupported role, authentication, or prepared transaction')
        # Keep the credential out of process arguments and normal/error SQL logs.
        # Only restricted lower-case identifiers and hex credentials reach SQL.
        change = ("SET log_statement='none'; SET log_min_error_statement='panic'; "
                  "ALTER ROLE \"" + role + "\" PASSWORD '" + password + "';\n")
        run(command, input=change)
    except Exception:
        # Never attach subprocess exceptions: they retain stdout and stderr.
        raise RotationError('isolated PostgreSQL rotation failed') from None
    finally:
        try:
            verified = _find_verified(run, name, operation_id, image, volume)
            if verified:
                # Never use -v: the data volume must remain intact.
                run(['docker', 'rm', '-f', verified])
        except Exception:
            cleanup_error = True
        if cleanup_error is not None:
            raise RotationError('isolated PostgreSQL cleanup failed; do not restart the stack') from None
