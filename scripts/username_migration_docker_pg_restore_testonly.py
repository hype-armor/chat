"""Incomplete PostgreSQL restore experiment; destructive restore is disabled.

This module performs non-destructive preflight checks only. The caller must
independently verify the rollback fence and trust the host and runner. No result
authorizes a restore.
"""
import hashlib
import json
import os
import stat
import subprocess
from contextlib import contextmanager

from username_migration_docker_pg_backup import _DOCKER, _ENV, _ID, _NAME, _OPERATION, _validate_database_properties
from username_migration_docker_pg_restore_check import _disk_directory, _valid_system_id, _SYSTEM_ID_SQL, _PROPERTIES_SQL
from username_migration_role_restore_sql import role_restore_sql


class RestoreError(RuntimeError):
    pass


class TestOnlyPostgresRestore:
    operational = False
    restore_authorized = False

    def __init__(self, *, directory_fd, source_system_identifier, operation,
                 role, database, archive_sha256, container_id,
                 verify_rollback_fence):
        try:
            st = os.fstat(directory_fd)
            if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid()
                    or stat.S_IMODE(st.st_mode) != 0o700
                    or not isinstance(source_system_identifier, str)
                    or not _valid_system_id(source_system_identifier)
                    or not isinstance(operation, str) or not _OPERATION.fullmatch(operation)
                    or not isinstance(role, str) or not _NAME.fullmatch(role)
                    or not isinstance(database, str) or not _NAME.fullmatch(database)
                    or database in ('postgres', 'template0', 'template1')
                    or not isinstance(archive_sha256, str) or not _ID.fullmatch(archive_sha256)
                    or not isinstance(container_id, str) or not _ID.fullmatch(container_id)
                    or not callable(verify_rollback_fence)):
                raise ValueError()
            _disk_directory(directory_fd)
        except Exception:
            raise RestoreError('invalid restore configuration') from None
        self._fd = directory_fd
        self._binding = (source_system_identifier, operation, role, database,
                         archive_sha256, container_id)
        self._verify = verify_rollback_fence

    def _fence(self, phase):
        try:
            if self._verify(phase, self._binding) is not True:
                raise ValueError()
        except Exception:
            raise RestoreError('rollback fence verification failed') from None

    @contextmanager
    def _snapshot(self):
        """Hold a read-only handle to the verified anonymous snapshot."""
        self._fence('before_snapshot')
        source = stage = readonly = None
        try:
            source = os.open('postgres.dump', os.O_RDONLY | os.O_NOFOLLOW |
                             os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self._fd)
            st = os.fstat(source)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid()
                    or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1):
                raise RestoreError('unsafe archive')
            stage = os.open('.', os.O_TMPFILE | os.O_RDWR | os.O_CLOEXEC,
                            0o600, dir_fd=self._fd)
            digest = hashlib.sha256()
            header = bytearray()
            while True:
                chunk = os.read(source, 1024 * 1024)
                if not chunk:
                    break
                if len(header) < 5:
                    header.extend(chunk[:5 - len(header)])
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    n = os.write(stage, view)
                    if n <= 0:
                        raise OSError('short write')
                    view = view[n:]
            os.fsync(stage)
            if bytes(header) != b'PGDMP' or digest.hexdigest() != self._binding[4]:
                raise RestoreError('archive magic or digest mismatch')
            readonly = os.open('/proc/self/fd/%d' % stage, os.O_RDONLY | os.O_CLOEXEC)
            original, reopened = os.fstat(stage), os.fstat(readonly)
            if (original.st_dev, original.st_ino) != (reopened.st_dev, reopened.st_ino):
                raise RestoreError('archive snapshot identity changed')
            os.close(stage)
            stage = None
            self._fence('after_snapshot')
            yield readonly
        except RestoreError:
            raise
        except Exception:
            raise RestoreError('snapshot check failed') from None
        finally:
            if readonly is not None:
                os.close(readonly)
            if stage is not None:
                os.close(stage)
            if source is not None:
                os.close(source)

    def check_snapshot(self):
        """Check archive magic and digest without authorizing a restore."""
        with self._snapshot():
            pass

    def preflight(self, *, runner):
        """Run non-destructive checks through a caller-supplied Docker runner."""
        if not callable(runner):
            raise RestoreError('invalid runner')

        def execute(command, phase, **kwargs):
            self._fence('before_' + phase)
            try:
                result = runner(_DOCKER + ['exec', '-i', '-e',
                    'PGOPTIONS=-c search_path=pg_catalog -c standard_conforming_strings=on',
                    self._binding[5]] + command, env=_ENV, stderr=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, check=False, timeout=300, **kwargs)
                if result.returncode != 0 or not isinstance(result.stdout, bytes):
                    raise RestoreError('Docker command failed')
                return result.stdout
            finally:
                self._fence('after_' + phase)

        with self._snapshot() as archive:
            identity = execute(['psql', '-X', '-qAt', '--no-password', '-v',
                                'ON_ERROR_STOP=1', '-U', self._binding[2], '-d', 'postgres'],
                               'identity', input=_SYSTEM_ID_SQL)
            if identity != self._binding[0].encode('ascii') + b'\n':
                raise RestoreError('source system identifier mismatch')
            listing = execute(['pg_restore', '--list'], 'list', stdin=archive)
            if len(listing) > 8 * 1024 * 1024:
                raise RestoreError('invalid archive listing')
            lines = listing.splitlines()
            headers = [line for line in lines if line.lower().lstrip(b'; \t').startswith(b'dbname:')]
            if headers != [b';     dbname: ' + self._binding[3].encode('ascii')]:
                raise RestoreError('archive database header mismatch')

    def _restore_disposable_test_only(self, *, runner, role_record=None, selected_database_properties=None):
        """Restore a synthetic cluster only, under an externally held fence.

        The optional trusted role record does not cover all PostgreSQL globals.
        This method does not authorize production use.
        """
        if not callable(runner):
            raise RestoreError('invalid runner')
        source, _, role, database, _, container = self._binding
        properties = None
        if selected_database_properties is not None:
            try:
                properties = json.loads(json.dumps(selected_database_properties, allow_nan=False))
                _validate_database_properties(properties, database, role)
            except Exception:
                raise RestoreError('invalid selected database properties') from None
        role_sql = None
        if role_record is not None:
            try:
                # Freeze the supplied record before any database replacement.
                record = json.loads(json.dumps(role_record, ensure_ascii=True))
                role_sql = role_restore_sql(role, record)
            except Exception:
                raise RestoreError('invalid role record') from None

        def execute(command, phase, **kwargs):
            self._fence('before_' + phase)
            try:
                result = runner(_DOCKER + ['exec', '-i', '-e',
                    'PGOPTIONS=-c search_path=pg_catalog -c standard_conforming_strings=on',
                    container] + command, env=_ENV, stderr=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, check=False, timeout=300, **kwargs)
                if result.returncode != 0 or not isinstance(result.stdout, bytes):
                    raise RestoreError('Docker command failed')
                return result.stdout
            finally:
                self._fence('after_' + phase)

        psql = ['psql', '-X', '-qAt', '--no-password', '-v',
                'ON_ERROR_STOP=1', '-U', role, '-d', 'postgres']

        def identity(phase):
            if execute(psql, phase, input=_SYSTEM_ID_SQL) != source.encode('ascii') + b'\n':
                raise RestoreError('source system identifier mismatch')

        with self._snapshot() as archive:
            identity('identity_before_list')
            scope_sql = ("SELECT (SELECT count(*) FROM pg_catalog.pg_authid WHERE rolname !~ '^pg_') = 1 "
                "AND EXISTS (SELECT 1 FROM pg_catalog.pg_authid WHERE rolname='%s' AND rolsuper AND rolcanlogin) "
                "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname NOT IN ('postgres','template0','template1','%s')) "
                "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_prepared_xacts) "
                "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m "
                "JOIN pg_catalog.pg_roles member ON member.oid=m.member "
                "JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid "
                "WHERE member.rolname !~ '^pg_' OR granted.rolname !~ '^pg_') "
                "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global'));\n") % (role, database)
            if execute(psql, 'scope_preflight', input=scope_sql.encode('ascii')) != b't\n':
                raise RestoreError('unsupported PostgreSQL scope')
            identity('identity_after_scope_preflight')
            if role_sql is not None:
                expiry_check = ' AND a.rolvaliduntil IS NULL' if record['rolvaliduntil'] is None else ''
                role_preflight = ("SELECT a.rolsuper AND a.rolcanlogin" + expiry_check +
                    " AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m "
                    "WHERE m.member=a.oid OR m.roleid=a.oid) "
                    "FROM pg_catalog.pg_authid a WHERE a.rolname='%s';\n") % role
                if execute(psql, 'role_preflight', input=role_preflight.encode('ascii')) != b't\n':
                    raise RestoreError('unsupported current role state')
                identity('identity_after_role_preflight')
            listing = execute(['pg_restore', '--list'], 'list', stdin=archive)
            if len(listing) > 8 * 1024 * 1024:
                raise RestoreError('invalid archive listing')
            headers = [line for line in listing.splitlines()
                       if line.lower().lstrip(b'; \t').startswith(b'dbname:')]
            if headers != [b';     dbname: ' + database.encode('ascii')]:
                raise RestoreError('archive database header mismatch')
            identity('identity_after_list')
            # The database might not exist after an interrupted restore.
            sql = ("SELECT pg_catalog.format('ALTER DATABASE %%I WITH ALLOW_CONNECTIONS false', datname) "
                   "FROM pg_catalog.pg_database WHERE datname = '%s'\\gexec\n"
                   "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity "
                   "WHERE datname = '%s' AND pid <> pg_catalog.pg_backend_pid();\n") % (database, database)
            execute(psql, 'disable_connections', input=sql.encode('ascii'))
            identity('identity_after_disable_connections')
            remaining = ("SELECT count(*) FROM pg_catalog.pg_stat_activity "
                         "WHERE datname = '%s' AND pid <> pg_catalog.pg_backend_pid();\n") % database
            if execute(psql, 'verify_no_sessions', input=remaining.encode('ascii')).strip() != b'0':
                raise RestoreError('database sessions remain')
            identity('identity_after_session_check')
            os.lseek(archive, 0, os.SEEK_SET)
            execute(['pg_restore', '--clean', '--if-exists', '--create', '--exit-on-error',
                     '--no-password', '-U', role, '-d', 'postgres'], 'restore', stdin=archive)
            identity('identity_after_restore')
            if role_sql is not None:
                execute(psql, 'role_restore', input=('BEGIN;\n' + role_sql + '\nCOMMIT;\n').encode('utf-8'))
                identity('identity_after_role_restore')
                # Compare in PostgreSQL so timestamp equivalence is not dependent on formatting.
                def literal(value):
                    return "pg_catalog.convert_from(pg_catalog.decode('%s','hex'),'UTF8')" % value.encode('utf-8').hex()
                flags = ('rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolcanlogin',
                         'rolreplication', 'rolbypassrls')
                checks = ['a.%s = %s' % (key, 'true' if record[key] else 'false') for key in flags]
                checks.append('a.rolconnlimit = %d' % record['rolconnlimit'])
                checks.append('a.rolpassword IS NOT DISTINCT FROM ' +
                              ('NULL' if record['rolpassword'] is None else literal(record['rolpassword'])))
                checks.append('a.rolvaliduntil IS NOT DISTINCT FROM ' +
                              ('NULL' if record['rolvaliduntil'] is None else literal(record['rolvaliduntil']) + '::pg_catalog.timestamptz'))
                settings = {key.lower(): value for key, value in record['settings'].items()}
                expected = literal(json.dumps(settings, ensure_ascii=True)) + '::pg_catalog.jsonb'
                checks.append("COALESCE((SELECT pg_catalog.jsonb_object_agg(pg_catalog.lower(pg_catalog.split_part(s, '=', 1)), pg_catalog.substr(s, pg_catalog.strpos(s, '=') + 1)) FROM pg_catalog.pg_db_role_setting d CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) s WHERE d.setrole = a.oid AND d.setdatabase = 0), '{}'::pg_catalog.jsonb) = " + expected)
                query = ('SELECT ' + ' AND '.join(checks) + ' FROM pg_catalog.pg_authid a WHERE a.rolname = ' + literal(role) + ';\n')
                if execute(psql, 'verify_role', input=query.encode('utf-8')) != b't\n':
                    raise RestoreError('role record mismatch')
                identity('identity_after_role_verification')
            if properties is not None:
                target_psql = ['psql', '-X', '-qAt', '--no-password', '-v',
                               'ON_ERROR_STOP=1', '-U', role, '-d', database]
                try:
                    restored = json.loads(execute(target_psql, 'verify_database_properties', input=_PROPERTIES_SQL))
                    _validate_database_properties(restored, database, role)
                    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
                    if canonical(restored) != canonical(properties):
                        raise ValueError()
                except Exception:
                    raise RestoreError('database properties mismatch') from None
                identity('identity_after_database_verification')

    def restore(self):
        """Always fail closed: reconciliation and restore checks are missing."""
        raise RestoreError('destructive restore is not implemented and is disabled')
