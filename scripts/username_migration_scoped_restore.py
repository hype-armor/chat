"""Experimental PostgreSQL database restore adapter, not a deployment updater.

The caller must independently fence every writer and control the Unix socket,
PostgreSQL binaries, cluster and private backup directory throughout. This does
not back up or restore blobs, Compose state, external roles or application data
outside PostgreSQL. No CLI is provided. Never use it to authorize a migration.
"""
import hashlib
import json
import os
import re
import stat
import subprocess


class RestoreError(RuntimeError):
    pass


_NAME = re.compile(r'[A-Za-z_][A-Za-z_0-9]{0,62}\Z')
_SYSTEM_ID = re.compile(r'[0-9]{1,20}\Z')
_PASSWORD = re.compile(r'(?:SCRAM-SHA-256\$[A-Za-z0-9$:/+=]+|md5[0-9a-f]{32})\Z')


def _environment(bindir, socket, port, role, library_path):
    if not os.path.isabs(bindir) or not os.path.isabs(socket):
        raise RestoreError('absolute binary and socket paths required')
    if type(port) is not int or not 1 <= port <= 65535 or not _NAME.fullmatch(role):
        raise RestoreError('invalid connection parameters')
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
           'PGHOST': socket, 'PGPORT': str(port), 'PGUSER': role,
           'PGDATABASE': 'postgres', 'PGCONNECT_TIMEOUT': '5',
           'PGOPTIONS': '-c search_path=pg_catalog -c standard_conforming_strings=on'}
    if library_path is not None:
        if not os.path.isabs(library_path):
            raise RestoreError('absolute library path required')
        env['LD_LIBRARY_PATH'] = library_path
    return env


def _command(bindir, program, args, env, *, input=None, stdin=None, stdout=None):
    try:
        result = subprocess.run([os.path.join(bindir, program), *args], env=env,
                                input=input, stdin=stdin, stdout=stdout if stdout is not None else subprocess.PIPE,
                                stderr=subprocess.DEVNULL, check=True, timeout=600)
        return result.stdout
    except (OSError, subprocess.SubprocessError):
        raise RestoreError(program + ' failed') from None


def _sql(bindir, env, statement, database='postgres'):
    return _command(bindir, 'psql', ['-X', '-qAt', '--no-password', '-v',
                    'ON_ERROR_STOP=1', '-d', database], env,
                    input=statement.encode()).decode().strip()


def _open_private(directory, name):
    if not _NAME.fullmatch(name):
        raise RestoreError('invalid archive name')
    dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(dfd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RestoreError('backup directory must be owned and private')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dfd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            os.close(fd)
            raise RestoreError('invalid backup file')
        return dfd, fd
    except BaseException:
        os.close(dfd)
        raise


def _snapshot_archive(directory_fd, source_fd, expected_sha256):
    """Copy verified bytes to an unnamed disk-backed inode and reopen read-only.

    The private directory and processes with the same effective user remain a
    trust boundary. A mutable archive path is never passed to pg_restore.
    Unsupported filesystems or insufficient space fail before database changes.
    """
    temp_fd = os.open('.', os.O_RDWR | os.O_TMPFILE | os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(temp_fd, view)
                if written <= 0:
                    raise RestoreError('short archive snapshot write')
                view = view[written:]
        if digest.hexdigest() != expected_sha256:
            raise RestoreError('backup digest mismatch')
        os.fsync(temp_fd)
        readonly = os.open('/proc/self/fd/' + str(temp_fd), os.O_RDONLY | os.O_CLOEXEC)
        original, reopened = os.fstat(temp_fd), os.fstat(readonly)
        if (original.st_dev, original.st_ino) != (reopened.st_dev, reopened.st_ino):
            os.close(readonly)
            raise RestoreError('archive snapshot identity changed')
        return readonly
    finally:
        os.close(temp_fd)


def _cluster_facts(bindir, env):
    try:
        return json.loads(_sql(bindir, env, """SELECT json_build_object(
          'system_id',(SELECT system_identifier::text FROM pg_control_system()),
          'role',current_user,
          'roles',(SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]'::json)
                   FROM pg_roles WHERE rolname !~ '^pg_'),
          'prepared',(SELECT count(*) FROM pg_prepared_xacts),
          'databases',(SELECT coalesce(json_agg(datname ORDER BY datname),'[]'::json)
                       FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')),
          'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user));"""))
    except (ValueError, KeyError):
        raise RestoreError('invalid cluster facts') from None


_ROLE_FLAGS = ('rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolcanlogin',
               'rolreplication', 'rolbypassrls')
_SETTING = re.compile(r'[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*\Z')
# Other GUCs can change parser, permissions, logging, timeouts, or sessions.
# Unsupported settings fail closed until a safe restoration method exists.
_SAFE_ROLE_SETTINGS = frozenset(('search_path', 'timezone'))


def _literal(value):
    return "'" + value.replace("'", "''") + "'"


def _validate_role_record(record):
    keys = set(_ROLE_FLAGS) | {'rolconnlimit', 'rolvaliduntil', 'rolpassword', 'settings'}
    if not isinstance(record, dict) or set(record) != keys:
        raise RestoreError('unsupported saved role record')
    if any(type(record[k]) is not bool for k in _ROLE_FLAGS):
        raise RestoreError('invalid saved role flags')
    # This helper reconnects as the sole role, including on retries.
    if not record['rolcanlogin']:
        raise RestoreError('saved role must permit login for recovery')
    if type(record['rolconnlimit']) is not int or not -1 <= record['rolconnlimit'] <= 2147483647:
        raise RestoreError('invalid saved role connection limit')
    password = record['rolpassword']
    if password is not None and (not isinstance(password, str) or not _PASSWORD.fullmatch(password)):
        raise RestoreError('unsupported saved role password hash')
    expiry = record['rolvaliduntil']
    # NULL means no expiration. PostgreSQL cannot set it back to NULL through
    # ALTER ROLE, so recovery may preserve it only while it remains NULL.
    if expiry is not None and (not isinstance(expiry, str) or len(expiry) > 100 or '\x00' in expiry):
        raise RestoreError('invalid saved role expiration')
    settings = record['settings']
    if not isinstance(settings, dict) or any(
            not isinstance(k, str) or not _SETTING.fullmatch(k) or k.lower() not in _SAFE_ROLE_SETTINGS or
            not isinstance(v, str) or '\x00' in v or len(v) > 8192
            for k, v in settings.items()):
        raise RestoreError('invalid saved role settings')


def _role_state(bindir, env, role):
    # UTC makes the expiration representation independent of session settings.
    statement = """SET timezone='UTC'; SELECT pg_catalog.json_build_object(
      'rolinherit', r.rolinherit, 'rolcreatedb', r.rolcreatedb,
      'rolcreaterole', r.rolcreaterole, 'rolcanlogin', r.rolcanlogin,
      'rolreplication', r.rolreplication, 'rolbypassrls', r.rolbypassrls,
      'rolconnlimit', r.rolconnlimit, 'rolvaliduntil', r.rolvaliduntil::text,
      'rolpassword', r.rolpassword,
      'settings', COALESCE((SELECT pg_catalog.json_object_agg(
          pg_catalog.split_part(s, '=', 1), pg_catalog.substr(s, pg_catalog.strpos(s, '=')+1))
        FROM pg_catalog.pg_db_role_setting d,
             pg_catalog.unnest(d.setconfig) s
        WHERE d.setrole=r.oid AND d.setdatabase=0), '{}'::json))
      FROM pg_catalog.pg_authid r WHERE r.rolname=""" + _literal(role) + ';'
    try:
        record = json.loads(_sql(bindir, env, statement))
        _validate_role_record(record)
        return record
    except (ValueError, TypeError):
        raise RestoreError('invalid saved role state') from None


def _encoded_sql_text(value):
    """Represent UTF-8 text without SQL quote or backslash ambiguity."""
    return "pg_catalog.convert_from(pg_catalog.decode('" + value.encode('utf-8').hex() + "','hex'),'UTF8')"


def _restore_role(bindir, env, role, record):
    _validate_role_record(record)
    flags = {'rolinherit': 'INHERIT', 'rolcreatedb': 'CREATEDB',
             'rolcreaterole': 'CREATEROLE', 'rolcanlogin': 'LOGIN',
             'rolreplication': 'REPLICATION', 'rolbypassrls': 'BYPASSRLS'}
    options = [(('' if record[k] else 'NO') + v) for k, v in flags.items()]
    options.append('CONNECTION LIMIT ' + str(record['rolconnlimit']))
    if record['rolvaliduntil'] is None:
        if _role_state(bindir, env, role)['rolvaliduntil'] is not None:
            raise RestoreError('cannot restore a changed NULL role expiration')
    else:
        options.append('VALID UNTIL ' + _literal(record['rolvaliduntil']))
    options.append('PASSWORD ' + (_literal(record['rolpassword']) if record['rolpassword'] is not None else 'NULL'))
    quoted_role = '"' + role + '"'
    statements = ["SET log_statement='none'", "SET log_min_error_statement='panic'",
                  "SET standard_conforming_strings=on", 'BEGIN',
                  'ALTER ROLE ' + quoted_role + ' ' + ' '.join(options),
                  'ALTER ROLE ' + quoted_role + ' RESET ALL']
    for name, value in sorted(record['settings'].items()):
        statements += ['SELECT pg_catalog.set_config(' + _encoded_sql_text(name) + ',' + _encoded_sql_text(value) + ',false)',
                       'ALTER ROLE ' + quoted_role + ' SET "' + name + '" FROM CURRENT']
    statements.append('COMMIT')
    _sql(bindir, env, ';'.join(statements) + ';')
    actual = _role_state(bindir, env, role)
    if actual != record:
        raise RestoreError('restored role state mismatch')


def restore_verified(*args, **kwargs):
    """Block production use until validation provenance and fencing exist."""
    raise RestoreError('operational restore is disabled pending security review and integration')


def _restore_disposable_test_only(*, bindir, socket, port, role, database, directory, archive,
                                  expected_system_id, expected_sha256, role_record,
                                  validated_archive_sha256, library_path=None):
    """Exercise a restore only against a disposable, synthetic test cluster.

    This destructive operation may only run before any new-version public
    traffic. The caller must validate a complete restore on a separate isolated
    cluster and supply that validation's archive digest. The caller must also
    protect the manifest and verify the cluster system ID independently. This
    function cannot establish writer exclusivity, check blob consistency, or
    recover a crash by itself. Equal digest arguments do not prove validation.
    Never call this test helper against a real deployment.
    """
    if not _NAME.fullmatch(database) or database in ('postgres', 'template0', 'template1'):
        raise RestoreError('invalid application database')
    if not _SYSTEM_ID.fullmatch(expected_system_id):
        raise RestoreError('invalid expected system identifier')
    if not re.fullmatch(r'[0-9a-f]{64}', expected_sha256) or validated_archive_sha256 != expected_sha256:
        raise RestoreError('archive has not been validated')
    _validate_role_record(role_record)
    env = _environment(bindir, socket, port, role, library_path)
    dfd, fd = _open_private(directory, archive)
    try:
        snapshot = _snapshot_archive(dfd, fd, expected_sha256)
        os.close(fd)
        fd = snapshot
        facts = _cluster_facts(bindir, env)
        if (facts.get('system_id') != expected_system_id or facts.get('role') != role
                or facts.get('roles') != [role] or facts.get('prepared') != 0
                or facts.get('superuser') is not True
                or facts.get('databases') not in ([], [database])):
            raise RestoreError('unsupported or mismatched cluster')
        if role_record['rolvaliduntil'] is None and _role_state(bindir, env, role)['rolvaliduntil'] is not None:
            raise RestoreError('cannot restore a changed NULL role expiration')
        # The input archive must be trusted: pg_restore executes its SQL. With
        # --create it uses the database name in the custom archive header.
        os.lseek(fd, 0, os.SEEK_SET)
        listing = _command(bindir, 'pg_restore', ['--list'], env, stdin=fd).decode()
        names = re.findall(r'^;\s+dbname:\s*(\S+)\s*$', listing, re.MULTILINE)
        if names != [database]:
            raise RestoreError('archive database does not match manifest')
        # Disable the application's existing DB and terminate its sessions.
        # A trusted supervisor must also stop superusers and all external writers.
        if facts['databases']:
            _sql(bindir, env, 'ALTER DATABASE "' + database + '" ALLOW_CONNECTIONS false;')
            _sql(bindir, env, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + database + "' AND pid <> pg_backend_pid();")
        os.lseek(fd, 0, os.SEEK_SET)
        _command(bindir, 'pg_restore', ['--clean', '--if-exists', '--create', '--exit-on-error',
                 '--no-password', '--dbname', 'postgres'], env, stdin=fd, stdout=subprocess.DEVNULL)
        _restore_role(bindir, env, role, role_record)
    finally:
        os.close(fd)
        os.close(dfd)
