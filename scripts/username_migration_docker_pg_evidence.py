"""Test-only binding verifier. This module never authorizes an operation.

The independent anchor is the SHA-256 of the complete binding file, retained
outside this directory with the locked journal. It must be captured independently.
Digests establish consistency, not provenance, isolation, or a successful restore.
Same-UID writers, directory ancestry, the host and the journal remain trusted.
Files can change after verification; the caller must maintain a continuous fence.
"""
import hashlib
import json
import os
import re
import uuid

from username_migration_systemd_gate import _rename_noreplace

import username_migration_evidence as evidence
from username_migration_docker_pg_backup import _NAME, _validate_database_properties
from username_migration_docker_pg_restore_check import _valid_system_id
from username_migration_scoped_restore import _validate_role_record


class VerificationError(RuntimeError):
    pass


operational = False
restore_authorized = False
_DIGEST = re.compile(r'[0-9a-f]{64}\Z')
_FILES = {'archive': 'postgres.dump', 'metadata': 'postgres-metadata.json',
          'validation': 'postgres-restore-check.json'}
_BINDING = 'postgres-evidence-binding.json'


def _read(dfd, name, limit):
    fd = evidence._open(dfd, name)
    try:
        before = os.fstat(fd)
        raw = bytearray()
        while len(raw) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        after = os.fstat(fd)
        ident = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(raw) > limit or ident(before) != ident(after):
            raise ValueError('file changed or is too large')
        return bytes(raw)
    finally:
        os.close(fd)


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    def invalid(value):
        raise ValueError('invalid JSON number')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def verify_test_only(*, journal, directory, independent_binding_sha256):
    """Check fixed private files against an independently retained digest.

    The caller must hold the journal lock. This does not prove provenance or
    authorize a restore.
    """
    return _verify(journal, directory, independent_binding_sha256, _BINDING)


def _verify(journal, directory, independent_binding_sha256, binding_name):
    try:
        if (not os.path.isabs(directory) or not isinstance(independent_binding_sha256, str)
                or not _DIGEST.fullmatch(independent_binding_sha256)):
            raise ValueError('missing independent anchor')
        state = evidence._state(journal, ('backup', 'migrate', 'start_new', 'rollback'))
        operation = state['operation_id']
        if not isinstance(operation, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{16,128}', operation):
            raise ValueError('invalid operation')
        dfd = evidence._directory(directory)
        try:
            binding_raw = _read(dfd, binding_name, 65536)
            if hashlib.sha256(binding_raw).hexdigest() != independent_binding_sha256:
                raise ValueError('binding anchor mismatch')
            binding = _json(binding_raw)
            if (not isinstance(binding, dict) or set(binding) != {'version', 'operation_id', 'files', 'operational_restore_authorized'}
                    or type(binding['version']) is not int or binding['version'] != 1
                    or binding['operation_id'] != operation or binding['operational_restore_authorized'] is not False
                    or not isinstance(binding['files'], dict) or set(binding['files']) != set(_FILES)):
                raise ValueError('invalid binding')
            for key, name in _FILES.items():
                item = binding['files'][key]
                if (not isinstance(item, dict) or set(item) != {'name', 'size', 'sha256'} or item['name'] != name
                        or type(item['size']) is not int or item['size'] <= 0
                        or not isinstance(item['sha256'], str) or not _DIGEST.fullmatch(item['sha256'])):
                    raise ValueError('invalid file record')
                if evidence._hash(dfd, name) != item:
                    raise ValueError('file digest mismatch')
            metadata = _json(_read(dfd, _FILES['metadata'], 1048576))
            validation = _json(_read(dfd, _FILES['validation'], 1048576))
            if not isinstance(metadata, dict) or set(metadata) != {'system_id', 'role', 'database', 'selected_database_properties', 'roles', 'databases', 'prepared', 'memberships'}:
                raise ValueError('invalid metadata')
            role, database = metadata['role'], metadata['database']
            if not isinstance(role, dict) or not isinstance(database, dict):
                raise ValueError('invalid role or database')
            role_name, db_name = role['rolname'], database['datname']
            if (not isinstance(role_name, str) or not _NAME.fullmatch(role_name)
                    or not isinstance(db_name, str) or not _NAME.fullmatch(db_name)
                    or db_name in ('postgres', 'template0', 'template1')
                    or role['rolsuper'] is not True or database['owner'] != role_name
                    or not _valid_system_id(metadata['system_id'])
                    or metadata['roles'] != [role_name] or metadata['databases'] != [db_name]
                    or type(metadata['prepared']) is not int or metadata['prepared'] != 0
                    or type(metadata['memberships']) is not int or metadata['memberships'] != 0):
                raise ValueError('invalid source facts')
            role_record = dict(role)
            del role_record['rolname'], role_record['rolsuper']
            _validate_role_record(role_record)
            props = metadata['selected_database_properties']
            _validate_database_properties(props, db_name, role_name)
            if (set(database) != {'datname', 'owner', 'encoding', 'datcollate', 'datctype', 'datconnlimit', 'datallowconn'}
                    or database['encoding'] != props['encoding'] or database['datcollate'] != props['collate']
                    or database['datctype'] != props['ctype'] or type(database['datconnlimit']) is not int
                    or database['datconnlimit'] != props['connection_limit'] or type(database['datallowconn']) is not bool):
                raise ValueError('database facts mismatch')
            if (not isinstance(validation, dict) or set(validation) != {'version', 'source_system_identifier', 'target_system_identifier', 'status', 'operational', 'restore_authorized', 'container_id', 'archive_sha256', 'selected_database_properties'}
                    or type(validation['version']) is not int or validation['version'] != 2
                    or validation['status'] != 'MATCHED' or validation['operational'] is not False
                    or validation['restore_authorized'] is not False
                    or validation['source_system_identifier'] != metadata['system_id']
                    or not _valid_system_id(validation['target_system_identifier'])
                    or validation['target_system_identifier'] == metadata['system_id']
                    or not isinstance(validation['container_id'], str) or not _DIGEST.fullmatch(validation['container_id'])
                    or validation['archive_sha256'] != binding['files']['archive']['sha256']
                    or _canonical(validation['selected_database_properties']) != _canonical(props)):
                raise ValueError('validation mismatch')
            # Recheck all paths after parsing. This detects ordinary concurrent changes,
            # not a hostile same-UID writer that races or changes files afterwards.
            for key, name in _FILES.items():
                if evidence._hash(dfd, name) != binding['files'][key]:
                    raise ValueError('file changed')
            if hashlib.sha256(_read(dfd, binding_name, 65536)).hexdigest() != independent_binding_sha256:
                raise ValueError('binding changed')
            if evidence._state(journal, ('backup', 'migrate', 'start_new', 'rollback')) != state:
                raise ValueError('journal changed')
            return {'operation_id': operation, 'operational': False, 'restore_authorized': False}
        finally:
            os.close(dfd)
    except Exception:
        raise VerificationError('test-only evidence verification failed') from None


def bind_test_only(*, journal, directory):
    """Create a durable test-only binding under the caller's journal lock.

    Persist the returned digest independently in the operation journal. A failure
    can leave a complete binding in place; retry with the same files and state.
    This digest never authorizes production restore or proves evidence provenance.
    The caller must continuously fence the files and journal against changes.
    """
    dfd = None
    temp = None
    try:
        if not os.path.isabs(directory):
            raise ValueError('directory must be absolute')
        state = evidence._state(journal, ('backup', 'migrate', 'start_new', 'rollback'))
        operation = state['operation_id']
        if not isinstance(operation, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{16,128}', operation):
            raise ValueError('invalid operation')
        dfd = evidence._directory(directory)
        if state['phase'] != 'backup':
            try:
                os.stat(_BINDING, dir_fd=dfd, follow_symlinks=False)
            except FileNotFoundError:
                raise ValueError('binding was not established before migration') from None
        files = {key: evidence._hash(dfd, name) for key, name in _FILES.items()}
        record = {'version': 1, 'operation_id': operation, 'files': files,
                  'operational_restore_authorized': False}
        raw = _canonical(record).encode('utf-8')
        digest = hashlib.sha256(raw).hexdigest()
        temp = 'pg-binding-' + uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=dfd)
        try:
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError('short write')
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        # Validate the complete candidate before it becomes the fixed binding.
        _verify(journal, directory, digest, temp)
        if evidence._state(journal, ('backup', 'migrate', 'start_new', 'rollback')) != state:
            raise ValueError('journal changed')
        try:
            _rename_noreplace(dfd, temp, _BINDING)
            temp = None
        except FileExistsError:
            if _read(dfd, _BINDING, 65536) != raw:
                raise ValueError('existing binding mismatch')
        verify_test_only(journal=journal, directory=directory, independent_binding_sha256=digest)
        fd = evidence._open(dfd, _BINDING)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(dfd)
        return digest
    except Exception:
        raise VerificationError('test-only evidence binding failed') from None
    finally:
        if dfd is not None:
            if temp is not None:
                try:
                    os.unlink(temp, dir_fd=dfd)
                except FileNotFoundError:
                    pass
            os.close(dfd)
