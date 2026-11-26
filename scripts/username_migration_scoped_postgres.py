"""Work in progress: scoped PostgreSQL topology inspection, NOT a rollback adapter.

Trust boundary: the caller must control the local socket, PostgreSQL binaries,
process environment, storage and network fence. Inspection cannot establish a
fence or prevent changes after inspection. Do not use this module to authorize
migration, backup, or recovery. Capture and restore deliberately fail closed.
"""
import json
import os
import re
import subprocess


class ScopeError(RuntimeError):
    pass


_NAME = re.compile(r'[A-Za-z_][A-Za-z_0-9]{0,62}\Z')
_SYSTEM_ID = re.compile(r'[0-9]{1,20}\Z')


def inspect_scope(*, bindir, socket, port, role, database, expected_system_id,
                  library_path=None):
    """Inspect a narrow dedicated cluster. This is not a fence or authorization.

    The trusted local socket must authenticate the specified superuser. The
    system ID must come from an independently protected durable manifest.
    PostgreSQL reserved roles and the standard template databases are allowed.
    This check is only a building block: a supported result is not a recovery
    guarantee, and concurrent changes can invalidate it immediately.
    """
    if not all(isinstance(x, str) and _NAME.fullmatch(x) for x in (role, database)):
        raise ScopeError('invalid role or database')
    if database in ('postgres', 'template0', 'template1'):
        raise ScopeError('application database must be distinct from maintenance databases')
    if not isinstance(expected_system_id, str) or not _SYSTEM_ID.fullmatch(expected_system_id):
        raise ScopeError('invalid expected system ID')
    if not os.path.isabs(bindir) or not os.path.isabs(socket):
        raise ScopeError('absolute binary and socket paths required')
    if type(port) is not int or not 1 <= port <= 65535:
        raise ScopeError('invalid port')
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C',
           'PGHOST': socket, 'PGPORT': str(port), 'PGUSER': role,
           'PGCONNECT_TIMEOUT': '5'}
    if library_path is not None:
        if not os.path.isabs(library_path):
            raise ScopeError('absolute library path required')
        env['LD_LIBRARY_PATH'] = library_path

    def query(db, sql):
        try:
            result = subprocess.run([os.path.join(bindir, 'psql'), '-X', '-qAt',
                                     '--no-password', '-v', 'ON_ERROR_STOP=1', '-d', db],
                                    input=sql, text=True, capture_output=True, env=env,
                                    check=True, timeout=30)
            return json.loads(result.stdout)
        except (subprocess.SubprocessError, OSError, ValueError) as exc:
            raise ScopeError('PostgreSQL scope query failed') from exc

    # Names have a deliberately restricted grammar before interpolation.
    facts = query('postgres', """SELECT json_build_object(
      'system_id', (SELECT system_identifier::text FROM pg_control_system()),
      'current_user', current_user,
      'roles', (SELECT coalesce(json_agg(json_build_object('name', rolname,
          'superuser', rolsuper, 'login', rolcanlogin) ORDER BY rolname), '[]'::json)
          FROM pg_roles WHERE rolname !~ '^pg_'),
      'databases', (SELECT coalesce(json_agg(json_build_object('name', datname,
          'owner', pg_get_userbyid(datdba)) ORDER BY datname), '[]'::json)
          FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')),
      'prepared', (SELECT count(*) FROM pg_prepared_xacts),
      'memberships', (SELECT count(*) FROM pg_auth_members m
          JOIN pg_roles member ON member.oid = m.member
          JOIN pg_roles granted ON granted.oid = m.roleid
          WHERE member.rolname !~ '^pg_' OR granted.rolname !~ '^pg_')
    );""")
    if facts['system_id'] != expected_system_id:
        raise ScopeError('system ID does not match manifest')
    if facts['current_user'] != role or facts['roles'] != [
            {'name': role, 'superuser': True, 'login': True}]:
        raise ScopeError('unsupported role topology')
    if facts['databases'] != [{'name': database, 'owner': role}]:
        raise ScopeError('unsupported database topology or owner')
    if facts['prepared'] or facts['memberships']:
        raise ScopeError('prepared transactions or role memberships are unsupported')
    # Check every connectable standard database too: extensions are per database.
    for db in ('postgres', 'template1', database):
        extensions = query(db, "SELECT coalesce(json_agg(extname ORDER BY extname), '[]'::json) FROM pg_extension;")
        if extensions != ['plpgsql']:
            raise ScopeError('unsupported extensions in database ' + db)
    return facts


def capture(*args, **kwargs):
    raise ScopeError('capture unavailable: durable metadata and validated restore are not implemented')


def restore(*args, **kwargs):
    raise ScopeError('restore unavailable: destructive recovery is not implemented')
