"""Experimental backup evidence. This module does not enable operational restore.

The caller must trust the binaries, directory ancestry, source and disposable
validation cluster, and fence source writers. Archive SQL executes on validation.
A private directory does not protect against another process with the same UID.
"""
import datetime
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess

import username_migration_scoped_restore as pg


def _private_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise ValueError('directory must be private and owned by caller')
    return fd


def _file(dfd, name):
    if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,62}', name):
        raise ValueError('invalid archive name')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or not info.st_size):
        os.close(fd)
        raise ValueError('unsafe archive')
    return fd


def _new(dfd, prefix):
    name = prefix + secrets.token_hex(16)
    return name, os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)


def _digest(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    h = hashlib.sha256()
    while True:
        part = os.read(fd, 1024 * 1024)
        if not part:
            return h.hexdigest()
        h.update(part)


def create_manifest(*, bindir, source_socket, source_port, validation_socket, validation_port,
                    role, database, directory, archive, library_path=None):
    """Copy and restore an archive, then publish private evidence under unique names.

    The source facts and archive must belong to the same fenced capture. This
    function cannot establish that relationship or protect against same-UID
    mutation. It deliberately does not authorize operational restoration.
    """
    if not pg._NAME.fullmatch(database) or not pg._NAME.fullmatch(role):
        raise ValueError('invalid database or role')
    source = pg._environment(bindir, source_socket, source_port, role, library_path)
    target = pg._environment(bindir, validation_socket, validation_port, role, library_path)
    dfd = _private_dir(directory)
    src = snapshot = manifest = None
    snapshot_name = manifest_name = manifest_pending = None
    published = False
    try:
        # A lock serializes cooperating users of this private directory.
        fcntl.flock(dfd, fcntl.LOCK_EX)
        src = _file(dfd, archive)
        snapshot_name, snapshot = _new(dfd, 'archive_')
        while True:
            chunk = os.read(src, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                view = view[os.write(snapshot, view):]
        os.fsync(snapshot)
        digest = _digest(snapshot)
        facts = json.loads(pg._sql(bindir, source, """SELECT json_build_object(
          'system_id',(SELECT system_identifier::text FROM pg_control_system()),
          'major',current_setting('server_version_num')::int / 10000,
          'role',current_user,
          'role_record',(SELECT row_to_json(r) FROM (SELECT rolname, rolsuper, rolinherit,
            rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls,
            rolconnlimit, rolvaliduntil, rolpassword FROM pg_authid WHERE rolname=current_user) r),
          'database',(SELECT row_to_json(d) FROM (SELECT datname, pg_encoding_to_char(encoding) AS encoding,
            datcollate, datctype, datallowconn, datconnlimit, pg_get_userbyid(datdba) AS owner
            FROM pg_database WHERE datname=current_database()) d))""", database))
        if not facts.get('role_record') or not facts.get('database') or facts['role'] != role:
            raise ValueError('source facts unavailable')
        target_facts = json.loads(pg._sql(bindir, target, """SELECT json_build_object(
          'system_id',(SELECT system_identifier::text FROM pg_control_system()),
          'major',current_setting('server_version_num')::int / 10000)"""))
        if target_facts['system_id'] == facts['system_id'] or target_facts['major'] != facts['major']:
            raise ValueError('validation requires a separate compatible cluster')
        os.lseek(snapshot, 0, os.SEEK_SET)
        listing = pg._command(bindir, 'pg_restore', ['--list'], target, stdin=snapshot).decode()
        if re.findall(r'^;\s+dbname:\s*(\S+)\s*$', listing, re.MULTILINE) != [database]:
            raise ValueError('archive database mismatch')
        temporary_db = 'chat_verify_' + secrets.token_hex(16)
        created = False
        try:
            pg._command(bindir, 'createdb', ['--no-password', '--template=template0', temporary_db], target)
            created = True
            os.lseek(snapshot, 0, os.SEEK_SET)
            pg._command(bindir, 'pg_restore', ['--exit-on-error', '--single-transaction',
                        '--no-password', '--dbname', temporary_db], target, stdin=snapshot,
                        stdout=subprocess.DEVNULL)
        finally:
            if created:
                pg._command(bindir, 'dropdb', ['--no-password', '--if-exists', temporary_db], target)
        if _digest(snapshot) != digest:
            raise ValueError('archive changed during verification')
        record = {'version': 1, 'archive': snapshot_name, 'sha256': digest,
                  'source': facts, 'evidence_created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'validation': {'system_id': target_facts['system_id'], 'major': target_facts['major'],
                                 'database_object_restore_completed': True,
                                 'owner_acl_commands_not_skipped': True,
                                 'database_properties_compared': False,
                                 'source_completeness_proved': False},
                  'operational_restore_authorized': False}
        manifest_pending, manifest = _new(dfd, 'pending_manifest_')
        payload = json.dumps(record, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        view = memoryview(payload)
        while view:
            view = view[os.write(manifest, view):]
        os.fsync(manifest)
        manifest_name = 'manifest_' + secrets.token_hex(16)
        # Publish only complete file contents. link() refuses replacement.
        os.link(manifest_pending, manifest_name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
        os.unlink(manifest_pending, dir_fd=dfd)
        manifest_pending = None
        os.fsync(dfd)
        published = True
        return manifest_name
    finally:
        for fd in (src, snapshot, manifest):
            if fd is not None:
                os.close(fd)
        if not published:
            for name in (snapshot_name, manifest_pending):
                if name:
                    try:
                        os.unlink(name, dir_fd=dfd)
                    except FileNotFoundError:
                        pass
            os.fsync(dfd)
        os.close(dfd)


def open_supervised_snapshot(*, directory, manifest_name, expected_manifest_sha256,
                             expected_system_id, expected_database, expected_role):
    """Open the verified bytes for a trusted, externally anchored test manifest.

    The caller must obtain the manifest digest and expected identity from a
    separate durable operation record, not from the manifest itself. This does
    not establish a writer fence, source provenance, or authorize restoration.
    Same-UID processes, trusted binaries and directory ancestry remain trusted.
    The caller owns the returned descriptor and must close it.
    """
    if not re.fullmatch(r'[0-9a-f]{64}', expected_manifest_sha256):
        raise ValueError('invalid external manifest digest')
    dfd = _private_dir(directory)
    manifest_fd = archive_fd = None
    try:
        manifest_fd = _file(dfd, manifest_name)
        data = os.read(manifest_fd, 65537)
        if len(data) > 65536 or hashlib.sha256(data).hexdigest() != expected_manifest_sha256:
            raise ValueError('manifest digest mismatch')
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate manifest key')
                value[key] = item
            return value
        record = json.loads(data, object_pairs_hook=unique)
        if (not isinstance(record, dict) or record.get('version') != 1
                or record.get('operational_restore_authorized') is not False
                or record.get('database') != expected_database):
            raise ValueError('invalid supervised evidence')
        source = record.get('source')
        validation = record.get('validation')
        if (not isinstance(source, dict) or source.get('system_id') != expected_system_id
                or not isinstance(expected_system_id, str)
                or not re.fullmatch(r'[0-9]{1,20}', expected_system_id)
                or source.get('role') != expected_role
                or type(source.get('major')) is not int or source['major'] < 1
                or not isinstance(source.get('role_record'), dict)
                or source['role_record'].get('rolname') != expected_role
                or not isinstance(validation, dict)
                or validation.get('database_object_restore_completed') is not True
                or validation.get('database_create_restore_completed') is not True
                or validation.get('selected_database_properties_compared') is not True
                or validation.get('owner_acl_commands_not_skipped') is not True
                or not isinstance(validation.get('system_id'), str)
                or not re.fullmatch(r'[0-9]{1,20}', validation['system_id'])
                or validation['system_id'] == expected_system_id
                or type(validation.get('major')) is not int
                or validation['major'] != source['major']):
            raise ValueError('source or validation identity mismatch')
        digest = record.get('sha256')
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('invalid archive digest')
        archive_fd = _file(dfd, record.get('archive'))
        snapshot_fd = pg._snapshot_archive(dfd, archive_fd, digest)
        return snapshot_fd, record
    finally:
        for fd in (manifest_fd, archive_fd):
            if fd is not None:
                os.close(fd)
        os.close(dfd)


def capture_and_verify_supervised(*, source, validation, database, directory):
    """Capture and verify using separately supervised disposable test clusters.

    Both endpoints must provide check() and run() from IsolatedPostgres. Their
    process, socket and directory identities are checked around each command.
    Same-UID processes and the supplied binaries remain trusted. This test-only
    evidence does not authorize production recovery or prove blob consistency.
    """
    if (not pg._NAME.fullmatch(database) or database in ('postgres', 'template0', 'template1')
            or source is validation):
        raise ValueError('distinct endpoints and an application database are required')

    def facts(endpoint, db):
        statement = """SELECT json_build_object(
          'system_id',(SELECT system_identifier::text FROM pg_control_system()),
          'major',current_setting('server_version_num')::int / 10000,
          'role',current_user,
          'role_record',(SELECT row_to_json(r) FROM (SELECT rolname, rolsuper,
            rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication,
            rolbypassrls, rolconnlimit, rolvaliduntil, rolpassword FROM pg_authid
            WHERE rolname=current_user) r))"""
        result = endpoint.run('psql', ['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1',
                              '-d', db, '-c', statement], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL)
        return json.loads(result.stdout)

    def database_properties(endpoint):
        # Database names have a restricted grammar before interpolation.
        statement = """SELECT json_build_object(
          'name', d.datname, 'owner', pg_get_userbyid(d.datdba),
          'encoding', pg_encoding_to_char(d.encoding), 'collate', d.datcollate,
          'ctype', d.datctype, 'connection_limit', d.datconnlimit,
          'comment', shobj_description(d.oid, 'pg_database'),
          'acl', (SELECT coalesce(json_agg(json_build_object(
             'grantor', pg_get_userbyid(a.grantor),
             'grantee', CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
             'privilege', a.privilege_type, 'grantable', a.is_grantable)
             ORDER BY pg_get_userbyid(a.grantor), CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, a.privilege_type), '[]'::json)
             FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a),
          'settings', (SELECT coalesce(json_agg(json_build_object(
             'role', CASE WHEN s.setrole=0 THEN '' ELSE pg_get_userbyid(s.setrole) END,
             'config', s.setconfig) ORDER BY CASE WHEN s.setrole=0 THEN '' ELSE pg_get_userbyid(s.setrole) END), '[]'::json)
             FROM pg_db_role_setting s WHERE s.setdatabase=d.oid))
          FROM pg_database d WHERE d.datname='""" + database + "'"
        result = endpoint.run('psql', ['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1',
                              '-d', 'postgres', '-c', statement], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL)
        if not result.stdout.strip():
            raise ValueError('database properties unavailable')
        return json.loads(result.stdout)

    source_facts = facts(source, database)
    source_database_properties = database_properties(source)
    target_facts = facts(validation, 'postgres')
    if (not source_facts.get('role_record') or not target_facts.get('role_record')
            or source_facts['system_id'] == target_facts['system_id']
            or source_facts['major'] != target_facts['major']):
        raise ValueError('verification requires distinct compatible clusters')
    dfd = _private_dir(directory)
    pending_archive = archive_name = pending_manifest = manifest_name = None
    archive_fd = manifest_fd = None
    target_db = 'chat_verify_' + secrets.token_hex(16)
    target_created = published = False
    try:
        fcntl.flock(dfd, fcntl.LOCK_EX)
        pending_archive, archive_fd = _new(dfd, 'pending_archive_')
        source.run('pg_dump', ['--no-password', '--format=custom', '--create',
                   '--dbname', database], stdout=archive_fd, stderr=subprocess.DEVNULL)
        if os.fstat(archive_fd).st_size == 0:
            raise ValueError('empty database capture')
        os.fsync(archive_fd)
        digest = _digest(archive_fd)
        # The isolated validator must not contain the application database.
        # Restore with --create so PostgreSQL also exercises database creation,
        # owner, database ACL and settings from the archive. This is not yet a
        # comparison against independent source metadata.
        existing = validation.run('psql', ['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1',
                                  '-d', 'postgres', '-c', "SELECT count(*) FROM pg_database WHERE datname='" + database + "'"],
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if existing.stdout.strip() != b'0':
            raise ValueError('validation database already exists')
        target_db = database
        target_created = True  # Intent: restore may create the DB before failing.
        try:
            os.lseek(archive_fd, 0, os.SEEK_SET)
            validation.run('pg_restore', ['--no-password', '--exit-on-error', '--create',
                           '--dbname', 'postgres'], stdin=archive_fd,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if database_properties(validation) != source_database_properties:
                raise ValueError('selected database properties differ after restore')
        finally:
            validation.run('dropdb', ['--no-password', '--if-exists', target_db],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            target_created = False
        if _digest(archive_fd) != digest:
            raise ValueError('archive changed during verification')
        if (facts(source, database) != source_facts
                or database_properties(source) != source_database_properties
                or facts(validation, 'postgres')['system_id'] != target_facts['system_id']):
            raise ValueError('endpoint facts changed during verification')
        archive_name = 'archive_' + secrets.token_hex(16)
        os.link(pending_archive, archive_name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
        os.unlink(pending_archive, dir_fd=dfd)
        pending_archive = None
        os.fsync(dfd)
        record = {'version': 1, 'archive': archive_name, 'sha256': digest,
                  'source': source_facts, 'database': database,
                  'selected_database_properties': source_database_properties,
                  'evidence_created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'validation': {'system_id': target_facts['system_id'],
                                 'major': target_facts['major'],
                                 'database_object_restore_completed': True,
                                 'database_create_restore_completed': True,
                                 'selected_database_properties_compared': True,
                                 'owner_acl_commands_not_skipped': True,
                                 'database_properties_compared': False,
                                 'source_completeness_proved': False},
                  'operational_restore_authorized': False}
        pending_manifest, manifest_fd = _new(dfd, 'pending_manifest_')
        payload = json.dumps(record, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        view = memoryview(payload)
        while view:
            written = os.write(manifest_fd, view)
            if written <= 0:
                raise OSError('short manifest write')
            view = view[written:]
        os.fsync(manifest_fd)
        manifest_name = 'manifest_' + secrets.token_hex(16)
        os.link(pending_manifest, manifest_name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
        os.unlink(pending_manifest, dir_fd=dfd)
        pending_manifest = None
        os.fsync(dfd)
        published = True
        return manifest_name
    finally:
        cleanup_failed = False
        if target_created:
            try:
                validation.run('dropdb', ['--no-password', '--if-exists', target_db],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                cleanup_failed = True
        try:
            for fd in (archive_fd, manifest_fd):
                if fd is not None:
                    os.close(fd)
            if not published:
                for name in (pending_archive, pending_manifest):
                    if name:
                        try:
                            os.unlink(name, dir_fd=dfd)
                        except FileNotFoundError:
                            pass
            os.fsync(dfd)
        finally:
            os.close(dfd)
        if cleanup_failed:
            raise RuntimeError('validation database cleanup failed') from None


def capture_and_verify(*, bindir, source_socket, source_port, validation_socket,
                       validation_port, role, database, directory, library_path=None):
    """Capture from the source and produce test-restore evidence.

    The caller must independently keep writers fenced, keep the private directory
    trusted, and prove both endpoint identities. The evidence does not authorize
    production restore or prove a backup of roles, database settings or blobs.
    """
    if not pg._NAME.fullmatch(database) or not pg._NAME.fullmatch(role):
        raise ValueError('invalid database or role')
    source = pg._environment(bindir, source_socket, source_port, role, library_path)
    identity_sql = "SELECT json_build_object('system_id',(SELECT system_identifier::text FROM pg_control_system()), 'major',current_setting('server_version_num')::int / 10000, 'role',current_user)"
    before = json.loads(pg._sql(bindir, source, identity_sql, database))
    if before.get('role') != role:
        raise ValueError('source role mismatch')
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    dfd = _private_dir(directory)
    capture_name = attestation_name = attestation_pending = None
    fd = attestation = None
    published = False
    try:
        capture_name, fd = _new(dfd, 'capture_')
        pg._command(bindir, 'pg_dump', ['--no-password', '--format=custom', '--create', '--dbname', database], source, stdout=fd)
        if os.fstat(fd).st_size == 0:
            raise ValueError('empty capture')
        os.fsync(fd)
        digest = _digest(fd)
        os.close(fd)
        fd = None
        after = json.loads(pg._sql(bindir, source, identity_sql, database))
        if before != after:
            raise ValueError('source identity changed during capture')
        manifest_name = create_manifest(bindir=bindir, source_socket=source_socket,
            source_port=source_port, validation_socket=validation_socket,
            validation_port=validation_port, role=role, database=database,
            directory=directory, archive=capture_name, library_path=library_path)
        verified = _file(dfd, manifest_name)
        try:
            with os.fdopen(verified, encoding='utf-8') as stream:
                record = json.load(stream)
        except BaseException:
            raise
        if (record.get('sha256') != digest or record.get('source', {}).get('system_id') != before['system_id']
                or record.get('source', {}).get('major') != before['major']):
            raise ValueError('capture and verification evidence disagree')
        attestation_pending, attestation = _new(dfd, 'pending_evidence_')
        evidence = {'version': 1, 'manifest': manifest_name, 'sha256': digest,
                    'source_system_id': before['system_id'], 'source_major': before['major'],
                    'capture_started_at': started,
                    'capture_completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'operational_restore_authorized': False}
        payload = json.dumps(evidence, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        view = memoryview(payload)
        while view:
            written = os.write(attestation, view)
            if written <= 0:
                raise OSError('short evidence write')
            view = view[written:]
        os.fsync(attestation)
        attestation_name = 'capture_evidence_' + secrets.token_hex(16)
        os.link(attestation_pending, attestation_name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
        os.unlink(attestation_pending, dir_fd=dfd)
        attestation_pending = None
        os.fsync(dfd)
        published = True
        return attestation_name
    finally:
        for opened in (fd, attestation):
            if opened is not None:
                os.close(opened)
        if capture_name:
            try:
                os.unlink(capture_name, dir_fd=dfd)
            except FileNotFoundError:
                pass
        if not published and attestation_pending:
            try:
                os.unlink(attestation_pending, dir_fd=dfd)
            except FileNotFoundError:
                pass
        os.fsync(dfd)
        os.close(dfd)
