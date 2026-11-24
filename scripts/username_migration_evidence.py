"""Durable operation-bound evidence for experimental synthetic recovery.

The caller must hold the journal lock and independently capture, validate and
fence every resource. This module binds private files to one operation; it does
not prove their provenance or authorize live recovery. Same-UID processes,
filesystem ancestry, binaries and the host administrator remain trusted.
"""
import hashlib
import json
import os
import re
import stat
import uuid

from username_migration_systemd_gate import _rename_noreplace


class EvidenceError(RuntimeError):
    pass


REQUIRED = frozenset(('database_archive', 'database_manifest', 'blob_archive',
                      'blob_inventory', 'runtime_manifest'))
NAME = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\Z')


def _directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise EvidenceError('evidence directory must be private and owned')
    return fd


def _open(dfd, name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise EvidenceError('invalid evidence filename')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size <= 0):
        os.close(fd)
        raise EvidenceError('unsafe evidence file')
    return fd


def _hash(dfd, name):
    fd = _open(dfd, name)
    try:
        before = os.fstat(fd)
        digest = hashlib.sha256()
        while True:
            part = os.read(fd, 1024 * 1024)
            if not part:
                break
            digest.update(part)
        os.fsync(fd)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if identity(before) != identity(after):
            raise EvidenceError('evidence changed while hashing')
        return {'name': name, 'size': before.st_size, 'sha256': digest.hexdigest()}
    finally:
        os.close(fd)


def _state(journal, phases):
    state = journal.load()
    if not isinstance(state, dict) or state.get('phase') not in phases:
        raise EvidenceError('journal phase does not permit evidence access')
    if state['phase'] == 'rollback' and state.get('restore_required') is not True:
        raise EvidenceError('rollback does not require restore')
    return state


def _read(dfd):
    fd = _open(dfd, 'recovery_evidence.json')
    try:
        raw = os.read(fd, 65537)
        if len(raw) > 65536:
            raise EvidenceError('evidence record is too large')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise EvidenceError('duplicate evidence key')
                result[key] = value
            return result
        record = json.loads(raw, object_pairs_hook=unique)
        os.fsync(fd)
        os.fsync(dfd)
        return record
    finally:
        os.close(fd)


def seal(journal, directory, files):
    """Bind already verified files before migration; do not infer verification.

    files maps each REQUIRED logical name to a unique private file in directory.
    The journal must already record backup intent. The caller must keep the
    journal lock, writer fence and file protection through restore.
    """
    state = _state(journal, ('backup',))
    if (not isinstance(files, dict) or set(files) != REQUIRED
            or len(set(files.values())) != len(REQUIRED)):
        raise EvidenceError('incomplete or duplicate evidence set')
    dfd = _directory(directory)
    temp = None
    try:
        record = {'version': 1, 'operation_id': state['operation_id'],
                  'files': {key: _hash(dfd, value) for key, value in sorted(files.items())},
                  'operational_restore_authorized': False}
        os.fsync(dfd)
        try:
            existing = _read(dfd)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if existing != record:
                raise EvidenceError('evidence already belongs to a different capture')
            return record
        temp = '.evidence-' + uuid.uuid4().hex
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=dfd)
        try:
            data = json.dumps(record, sort_keys=True, separators=(',', ':')).encode() + b'\n'
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                if n <= 0:
                    raise OSError('short evidence write')
                view = view[n:]
            os.fsync(fd)
        finally:
            os.close(fd)
        _rename_noreplace(dfd, temp, 'recovery_evidence.json')
        temp = None
        os.fsync(dfd)
        return record
    finally:
        if temp is not None:
            try:
                os.unlink(temp, dir_fd=dfd)
            except FileNotFoundError:
                pass
        os.close(dfd)


def load(journal, directory):
    """Recheck every bound file. This does not authorize an operational restore."""
    state = _state(journal, ('backup', 'migrate', 'start_new', 'rollback'))
    dfd = _directory(directory)
    try:
        record = _read(dfd)
        if (not isinstance(record, dict) or set(record) != {'version', 'operation_id', 'files', 'operational_restore_authorized'}
                or type(record['version']) is not int or record['version'] != 1
                or record['operation_id'] != state['operation_id']
                or record['operational_restore_authorized'] is not False
                or not isinstance(record['files'], dict) or set(record['files']) != REQUIRED):
            raise EvidenceError('invalid or mismatched evidence record')
        names = []
        for item in record['files'].values():
            if not isinstance(item, dict) or set(item) != {'name', 'size', 'sha256'}:
                raise EvidenceError('invalid evidence file record')
            name = item['name']
            names.append(name)
            if _hash(dfd, name) != item:
                raise EvidenceError('evidence file digest mismatch')
        if len(set(names)) != len(REQUIRED):
            raise EvidenceError('duplicate evidence files')
        return record
    finally:
        os.close(dfd)
