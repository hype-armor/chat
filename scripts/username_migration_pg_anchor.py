"""Durable journal-side anchor for the test-only PostgreSQL evidence binding.

The journal lock and trusted private directory must remain held throughout use.
This record gives consistency only. It proves neither provenance nor restore
success and does not authorize operational restore. Same-UID writers and the
host remain trusted. The journal schema is not changed.
"""
import json
import os
import re
import uuid

from username_migration_systemd_gate import _rename_noreplace


class AnchorError(RuntimeError):
    pass


_NAME = 'postgres-evidence-anchor.json'
_DIGEST = re.compile(r'[0-9a-f]{64}\Z')
_READ_PHASES = ('backup', 'migrate', 'start_new', 'rollback')


def _state(journal, phases):
    journal._require_open()
    state = journal.load()
    if not isinstance(state, dict) or state.get('phase') not in phases:
        raise AnchorError('journal phase does not permit anchor access')
    if state['phase'] == 'rollback' and state.get('restore_required') is not True:
        raise AnchorError('rollback does not require restore')
    operation = state.get('operation_id')
    try:
        if not isinstance(operation, str) or str(uuid.UUID(operation)) != operation:
            raise ValueError()
    except (ValueError, AttributeError):
        raise AnchorError('invalid operation ID') from None
    return state


def _payload(operation, digest):
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        raise AnchorError('invalid SHA-256 digest')
    return (json.dumps({'version': 1, 'operation_id': operation, 'sha256': digest},
                       sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')


def _sync(journal, fd):
    try:
        os.fsync(fd)
        os.fsync(journal.dirfd)
    except BaseException:
        journal.failed = True
        raise


def _read(journal, state):
    fd = os.open(_NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                 dir_fd=journal.dirfd)
    try:
        journal._check_file(fd)
        before = os.fstat(fd)
        raw = os.read(fd, 4097)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(raw) > 4096 or identity(before) != identity(after):
            raise AnchorError('anchor changed or is too large')
        try:
            record = json.loads(raw)
            digest = record['sha256']
            if raw != _payload(state['operation_id'], digest):
                raise ValueError()
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            raise AnchorError('invalid or mismatched anchor') from None
        _sync(journal, fd)
        return digest
    finally:
        os.close(fd)


def load_anchor(journal):
    """Read and resync the anchor in backup or a restore recovery phase."""
    state = _state(journal, _READ_PHASES)
    digest = _read(journal, state)
    if _state(journal, _READ_PHASES) != state:
        raise AnchorError('journal changed during anchor read')
    return digest


def store_anchor(journal, digest):
    """Publish the binder digest in backup, or verify and resync an exact retry.

    A failed write can leave a published anchor. Stop effects and reopen the
    journal before retrying. The caller must protect the directory continuously.
    """
    state = _state(journal, ('backup',))
    payload = _payload(state['operation_id'], digest)
    try:
        existing = _read(journal, state)
    except FileNotFoundError:
        pass
    else:
        if existing != digest:
            raise AnchorError('anchor digest mismatch')
        return existing

    name = '.pg-anchor-' + uuid.uuid4().hex
    fd = None
    try:
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=journal.dirfd)
            journal._check_file(fd)
            view = memoryview(payload)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError('short anchor write')
                view = view[count:]
            os.fsync(fd)
            os.close(fd)
            fd = None
            if _state(journal, ('backup',)) != state:
                raise AnchorError('journal changed during anchor write')
            try:
                _rename_noreplace(journal.dirfd, name, _NAME)
            except FileExistsError:
                if _read(journal, state) != digest:
                    raise AnchorError('anchor digest mismatch')
            else:
                os.fsync(journal.dirfd)
        except BaseException:
            journal.failed = True
            raise
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(name, dir_fd=journal.dirfd)
        except FileNotFoundError:
            pass
    return digest
