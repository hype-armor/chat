"""Test-only recovery-set consistency anchor; not an operational gate.

The caller must hold the private journal lock and the same fence throughout.
Injected callbacks are trusted test fixtures, not proof of provenance or fencing.
No function here authorizes migration or restore. The caller must invoke these
checks at every relevant boundary; this module does not alter the journal.
"""
import hashlib
import json
import os
import re
import uuid

from username_migration_systemd_gate import _rename_noreplace


class AnchorError(RuntimeError):
    pass


_NAME = 'recovery-set-anchor-testonly.json'
_DIGEST = re.compile(r'[0-9a-f]{64}\Z')
_PHASES = ('backup', 'migrate', 'start_new', 'rollback')
_LIMIT = 8192
_TOKEN_LIMIT = 1024


def _state(journal, phases):
    journal._require_open()
    state = journal.load()
    if not isinstance(state, dict) or state.get('phase') not in phases:
        raise AnchorError('invalid journal phase')
    if state['phase'] == 'rollback' and state.get('restore_required') is not True:
        raise AnchorError('rollback does not require restore')
    operation = state.get('operation_id')
    try:
        if not isinstance(operation, str) or str(uuid.UUID(operation)) != operation:
            raise ValueError()
    except (ValueError, AttributeError):
        raise AnchorError('invalid operation ID') from None
    return state


def _payload(operation, components, fence_digest):
    if (not isinstance(components, dict) or set(components) != {'postgres', 'blob', 'runtime'}
            or not isinstance(components['runtime'], dict) or not components['runtime']):
        raise AnchorError('invalid components')
    for name, digest in components['runtime'].items():
        if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', name):
            raise AnchorError('invalid runtime name')
    digests = [components['postgres'], components['blob'], *components['runtime'].values()]
    if any(not isinstance(d, str) or not _DIGEST.fullmatch(d) for d in digests):
        raise AnchorError('invalid digest')
    raw = (json.dumps({'version': 2, 'operation_id': operation, 'components': components,
                       'fence_sha256': fence_digest},
                      sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode('ascii')
    if len(raw) > _LIMIT:
        raise AnchorError('anchor too large')
    return raw


def _collect(journal, state, boundary, verify_postgres, verify_blob, verify_runtime):
    """Require the same nonempty fence token around every independent callback."""
    token = boundary()
    if not isinstance(token, str) or not token or len(token) > _TOKEN_LIMIT:
        raise AnchorError('invalid fence token')
    try:
        token_bytes = token.encode('utf-8')
    except UnicodeEncodeError:
        raise AnchorError('invalid fence token') from None
    if len(token_bytes) > _TOKEN_LIMIT:
        raise AnchorError('invalid fence token')
    fence_digest = hashlib.sha256(token_bytes).hexdigest()

    def check():
        if boundary() != token:
            raise AnchorError('fence changed')
        if _state(journal, _PHASES) != state:
            raise AnchorError('journal changed')

    results = []
    for verify in (verify_postgres, verify_blob, verify_runtime):
        check()
        result = verify()
        check()
        results.append(result)
    components = dict(zip(('postgres', 'blob', 'runtime'), results))
    payload = _payload(state['operation_id'], components, fence_digest)
    return payload, check


def _read(journal):
    try:
        fd = os.open(_NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                     dir_fd=journal.dirfd)
    except FileNotFoundError:
        raise AnchorError('missing recovery anchor') from None
    try:
        journal._check_file(fd)
        before = os.fstat(fd)
        raw = os.read(fd, _LIMIT + 1)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(raw) > _LIMIT or identity(before) != identity(after):
            raise AnchorError('anchor changed or is too large')
        try:
            os.fsync(fd)
            os.fsync(journal.dirfd)
        except BaseException:
            journal.failed = True
            raise
        return raw
    finally:
        os.close(fd)


def verify_anchor(journal, *, boundary, verify_postgres, verify_blob, verify_runtime):
    """Reverify all components against the operation-bound anchor, or fail closed."""
    state = _state(journal, _PHASES)
    payload, check = _collect(journal, state, boundary, verify_postgres, verify_blob, verify_runtime)
    if _read(journal) != payload:
        raise AnchorError('recovery anchor mismatch')
    check()
    return payload


def store_anchor(journal, *, boundary, verify_postgres, verify_blob, verify_runtime):
    """Publish once in backup, or verify an exact retry after reopening on failure."""
    state = _state(journal, ('backup',))
    payload, check = _collect(journal, state, boundary, verify_postgres, verify_blob, verify_runtime)
    try:
        existing = _read(journal)
    except AnchorError as exc:
        if str(exc) != 'missing recovery anchor':
            raise
    else:
        if existing != payload:
            raise AnchorError('recovery anchor mismatch')
        check()
        return payload
    name = '.recovery-anchor-' + uuid.uuid4().hex
    fd = None
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
        check()
        try:
            _rename_noreplace(journal.dirfd, name, _NAME)
        except FileExistsError:
            if _read(journal) != payload:
                raise AnchorError('recovery anchor mismatch')
        else:
            os.fsync(journal.dirfd)
        check()
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
    return payload
