"""Experimental disposable restore check. This does not authorize operations.

The caller must continuously fence writers and independently verify isolation in
`gate`. Trust the host, Docker administrator, source properties, and runner.
The gate must return exactly True only while the same isolated container and
volume remain safe. This module neither creates nor deletes Docker objects.
"""
import ctypes
import hashlib
import json
import os
import re
import stat
import subprocess

from username_migration_docker_pg_backup import (
    _DOCKER, _ENV, _ID, _NAME, _validate_database_properties,
)


class RestoreCheckError(RuntimeError):
    pass


def _valid_system_id(value):
    return (isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,19}', value) is not None
            and int(value) <= 18446744073709551615)


_SYSTEM_ID_SQL = b'SELECT system_identifier::text FROM pg_control_system();\n'


# This expression is the selected_database_properties query used by capture.
_PROPERTIES_SQL = b"""SELECT json_build_object(
                'name', d.datname, 'owner', pg_get_userbyid(d.datdba),
                'encoding', pg_encoding_to_char(d.encoding), 'collate', d.datcollate,
                'ctype', d.datctype, 'connection_limit', d.datconnlimit,
                'comment', shobj_description(d.oid,'pg_database'),
                'acl', (SELECT coalesce(json_agg(json_build_object(
                  'grantor',pg_get_userbyid(a.grantor),
                  'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                  'privilege',a.privilege_type,'grantable',a.is_grantable)
                  ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type),'[]'::json)
                  FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a),
                'settings', (SELECT coalesce(json_agg(json_build_object(
                  'role',CASE WHEN s.setrole=0 THEN '' ELSE pg_get_userbyid(s.setrole) END,'config',s.setconfig)
                  ORDER BY CASE WHEN s.setrole=0 THEN '' ELSE pg_get_userbyid(s.setrole) END),'[]'::json)
                  FROM pg_db_role_setting s WHERE s.setdatabase=d.oid))
                FROM pg_database d WHERE d.datname=current_database();\n"""


def _disk_directory(fd):
    """Allow known disk-backed Linux filesystems only; do not fall back to tmpfs."""
    buf = ctypes.create_string_buffer(256)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(fd, ctypes.byref(buf)) != 0:
        raise RestoreCheckError('cannot identify staging filesystem')
    magic = ctypes.c_long.from_buffer(buf).value & 0xffffffff
    # ext*, XFS, Btrfs, overlay, and ZFS. Overlay backing is not reliably
    # identifiable, so it is deliberately not allowed.
    if magic not in (0xef53, 0x58465342, 0x9123683e, 0x2fc12fc1):
        raise RestoreCheckError('staging filesystem is not known to be disk-backed')


class DisposableRestoreCheck:
    operational = False
    restore_authorized = False

    def __init__(self, *, directory_fd, expected_sha256, selected_database_properties,
                 expected_source_system_identifier, container_id, gate, runner=subprocess.run):
        try:
            st = os.fstat(directory_fd)
            if (not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid()
                    or stat.S_IMODE(st.st_mode) != 0o700
                    or not isinstance(expected_sha256, str) or not _ID.fullmatch(expected_sha256)
                    or not _valid_system_id(expected_source_system_identifier)
                    or not isinstance(container_id, str) or not _ID.fullmatch(container_id)
                    or not callable(gate) or not callable(runner)):
                raise ValueError()
            # Freeze caller-owned data so it cannot change during the check.
            properties = json.loads(json.dumps(selected_database_properties, allow_nan=False))
            database, role = properties['name'], properties['owner']
            if (not isinstance(database, str) or not _NAME.fullmatch(database)
                    or database in ('postgres', 'template0', 'template1')
                    or not isinstance(role, str) or not _NAME.fullmatch(role)):
                raise ValueError()
            _validate_database_properties(properties, database, role)
            _disk_directory(directory_fd)
        except Exception:
            raise RestoreCheckError('invalid restore check configuration') from None
        self.fd, self.digest, self.properties = directory_fd, expected_sha256, properties
        self.container, self.gate, self.runner = container_id, gate, runner
        self.source_id = expected_source_system_identifier
        self.target_id = None

    def _gate(self):
        try:
            if self.gate() is not True:
                raise ValueError()
        except Exception:
            raise RestoreCheckError('isolation gate failed') from None

    def _raw_exec(self, command, **kwargs):
        self._gate()
        try:
            try:
                result = self.runner(_DOCKER + ['exec', '-i', '-e',
                    'PGOPTIONS=-c search_path=pg_catalog -c standard_conforming_strings=on',
                    self.container] + command, env=_ENV, stderr=subprocess.DEVNULL,
                    check=False, timeout=300, **kwargs)
                if result.returncode != 0:
                    raise ValueError()
                return result
            except Exception:
                raise RestoreCheckError('Docker command failed') from None
        finally:
            self._gate()

    def _identity(self):
        result = self._raw_exec(['psql', '-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1',
                                 '-U', self.properties['owner'], '-d', 'postgres'],
                                input=_SYSTEM_ID_SQL, stdout=subprocess.PIPE)
        try:
            raw = result.stdout
            if not isinstance(raw, bytes) or len(raw) > 21 or not raw.endswith(b'\n'):
                raise ValueError()
            target = raw[:-1].decode('ascii')
            if (not _valid_system_id(target) or target == self.source_id
                    or (self.target_id is not None and target != self.target_id)):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise RestoreCheckError('target system identifier mismatch') from None
        self.target_id = target

    def _exec(self, command, **kwargs):
        self._identity()
        result = self._raw_exec(command, **kwargs)
        self._identity()
        return result

    def check(self):
        """Validate postgres.dump and write private evidence; never authorize restore."""
        role, database = self.properties['owner'], self.properties['name']
        try:
            try:
                os.stat('postgres-restore-check.json', dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise RestoreCheckError('restore check evidence already exists')
            source = os.open('postgres.dump', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self.fd)
            try:
                st = os.fstat(source)
                if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid()
                        or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1):
                    raise RestoreCheckError('unsafe archive')
                stage = os.open('.', os.O_TMPFILE | os.O_RDWR | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
                try:
                    digest = hashlib.sha256()
                    while True:
                        chunk = os.read(source, 1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                        view = memoryview(chunk)
                        while view:
                            written = os.write(stage, view)
                            if written <= 0:
                                raise OSError('short write')
                            view = view[written:]
                    os.fsync(stage)
                    if digest.hexdigest() != self.digest:
                        raise RestoreCheckError('archive digest mismatch')
                    os.lseek(stage, 0, os.SEEK_SET)
                    listing = self._exec(['pg_restore', '--list'], stdin=stage, stdout=subprocess.PIPE).stdout
                    if not isinstance(listing, bytes) or len(listing) > 8 * 1024 * 1024:
                        raise RestoreCheckError('invalid archive listing')
                    names = [line[len(b';     dbname: '):] for line in listing.splitlines()
                             if line.startswith(b';     dbname: ')]
                    if names != [database.encode('ascii')]:
                        raise RestoreCheckError('archive database mismatch')
                    os.lseek(stage, 0, os.SEEK_SET)
                    self._exec(['pg_restore', '--create', '--exit-on-error', '--no-password',
                                '-U', role, '-d', 'postgres'], stdin=stage, stdout=subprocess.DEVNULL)
                finally:
                    os.close(stage)
            finally:
                os.close(source)
            result = self._exec(['psql', '-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1',
                                 '-U', role, '-d', database], input=_PROPERTIES_SQL, stdout=subprocess.PIPE)
            if not isinstance(result.stdout, bytes) or len(result.stdout) > 1048576:
                raise RestoreCheckError('invalid restored properties')
            target = json.loads(result.stdout)
            _validate_database_properties(target, database, role)
            # Canonical JSON comparison also distinguishes booleans from numbers.
            canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
            if canonical(target) != canonical(self.properties):
                raise RestoreCheckError('restored properties mismatch')
            self._identity()
            self._gate()
            evidence = {'version': 2, 'source_system_identifier': self.source_id,
                        'target_system_identifier': self.target_id, 'status': 'MATCHED', 'operational': False,
                        'restore_authorized': False, 'container_id': self.container,
                        'archive_sha256': self.digest, 'selected_database_properties': target}
            raw = (canonical(evidence) + '\n').encode()
            # Publish only a complete fsynced record and never replace evidence.
            tmp = '.restore-check-' + os.urandom(16).hex()
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as f:
                    f.write(raw)
                    f.flush()
                    os.fsync(fd)
                self._gate()
                os.link(tmp, 'postgres-restore-check.json', src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
                os.fsync(self.fd)
            finally:
                os.close(fd)
                os.unlink(tmp, dir_fd=self.fd)
                os.fsync(self.fd)
            return evidence
        except RestoreCheckError:
            raise
        except Exception:
            raise RestoreCheckError('restore check failed') from None
