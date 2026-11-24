"""Experimental SQL generation only. Not an operational restore interface.

The caller must fence concurrent role changes, execute the complete statement in
one transaction, and verify the resulting state. SQL and database logs can expose
password hashes. No logging configuration or confidentiality is guaranteed.
"""
import re


class RoleRecordError(ValueError):
    pass


_FLAGS = {'rolinherit': 'INHERIT', 'rolcreatedb': 'CREATEDB',
          'rolcreaterole': 'CREATEROLE', 'rolcanlogin': 'LOGIN',
          'rolreplication': 'REPLICATION', 'rolbypassrls': 'BYPASSRLS'}
_NAME = re.compile(r'[A-Za-z_][A-Za-z_0-9]{0,62}\Z', re.ASCII)
_PASSWORD = re.compile(r'(?:SCRAM-SHA-256\$[A-Za-z0-9$:/+=]+|md5[0-9a-f]{32})\Z', re.ASCII)


def _text(value):
    try:
        data = value.encode('utf-8')
    except UnicodeEncodeError:
        raise RoleRecordError('invalid UTF-8 text') from None
    return "pg_catalog.convert_from(pg_catalog.decode('" + data.hex() + "','hex'),'UTF8')"


def role_restore_sql(role, record):
    """Generate a single SQL statement, without connecting to PostgreSQL.

    The NULL-expiry check and ALTER are not a concurrency fence. A caller must
    prevent all concurrent role changes, including between the check and ALTER.
    PostgreSQL may reject invalid setting values or expiration timestamps.
    """
    if not isinstance(role, str) or not _NAME.fullmatch(role):
        raise RoleRecordError('invalid role name')
    if not isinstance(record, dict) or set(record) != set(_FLAGS) | {'rolconnlimit', 'rolvaliduntil', 'rolpassword', 'settings'}:
        raise RoleRecordError('unsupported role record')
    if any(type(record[k]) is not bool for k in _FLAGS) or not record['rolcanlogin']:
        raise RoleRecordError('invalid role flags')
    limit = record['rolconnlimit']
    if type(limit) is not int or not -1 <= limit <= 2147483647:
        raise RoleRecordError('invalid connection limit')
    password = record['rolpassword']
    if password is not None and (not isinstance(password, str) or not _PASSWORD.fullmatch(password)):
        raise RoleRecordError('invalid password hash')
    expiry = record['rolvaliduntil']
    if expiry is not None and (not isinstance(expiry, str) or len(expiry) > 100 or '\x00' in expiry):
        raise RoleRecordError('invalid expiration')
    settings = record['settings']
    if not isinstance(settings, dict) or any(
        not isinstance(k, str) or k.lower() not in ('timezone', 'search_path') or
        not isinstance(v, str) or '\x00' in v or len(v) > 8192
        for k, v in settings.items()
    ) or len({k.lower() for k in settings}) != len(settings):
        raise RoleRecordError('invalid settings')
    options = ' '.join(('' if record[k] else 'NO') + v for k, v in _FLAGS.items())
    options += ' CONNECTION LIMIT ' + str(limit)
    role_expr = _text(role)
    lines = ['DO $role_restore$', 'DECLARE role_name text := ' + role_expr + ';', 'BEGIN']
    if expiry is None:
        lines.append("IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_authid WHERE rolname = role_name AND rolvaliduntil IS NULL) THEN RAISE EXCEPTION 'role missing or NULL expiry changed'; END IF;")
    # format() provides SQL literals regardless of standard_conforming_strings.
    command = 'ALTER ROLE %I ' + options + ' PASSWORD '
    if password is None:
        command += 'NULL'
        args = 'role_name'
    else:
        command += '%L'
        args = 'role_name, ' + _text(password)
    if expiry is not None:
        command += ' VALID UNTIL %L'
        args += ', ' + _text(expiry)
    lines.append("EXECUTE pg_catalog.format('" + command + "', " + args + ');')
    lines.append("EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL', role_name);")
    for name, value in sorted(settings.items()):
        lines.append('PERFORM pg_catalog.set_config(' + _text(name) + ', ' + _text(value) + ', true);')
        lines.append("EXECUTE pg_catalog.format('ALTER ROLE %I SET %I FROM CURRENT', role_name, " + _text(name) + ');')
    lines.extend(['END', '$role_restore$;'])
    return '\n'.join(lines)
