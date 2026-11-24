"""Test-only durable epochs. Injected authority and fence prove no real identity.

This does not authorize restore. Hold the real journal lock throughout each call.
A caller must choose the next epoch and resolve uncertain effects externally.
Lock probes are point-in-time checks. They cannot prove continuous exclusion or
detect every unlock and reacquire gap. The caller must prevent such gaps.
"""
import errno
import fcntl
import hashlib
import json
import os
import re
import uuid
from dataclasses import asdict, dataclass

from username_migration_recovery_epoch_model_testonly import Identity
from username_migration_recovery_anchor_testonly import _state
from username_migration_systemd_gate import _rename_noreplace


class EpochError(RuntimeError):
    pass


PREFIX = 'recovery-epoch-testonly-'
FAILURE_PREFIX = '.epoch-testonly-failure-'
LIMIT = 8192


def _raw(record):
    return (json.dumps(record, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode('ascii')


def _read(journal, name, with_identity=False):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=journal.dirfd)
    try:
        journal._check_file(fd)
        before = os.fstat(fd)
        raw = os.read(fd, LIMIT + 1)
        after = os.fstat(fd)
        if len(raw) > LIMIT or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise EpochError('unstable epoch')
        try:
            os.fsync(fd)
            os.fsync(journal.dirfd)
        except BaseException:
            journal.failed = True
            raise
        key = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        return (key, raw) if with_identity else raw
    finally:
        os.close(fd)


def pin_journal(journal):
    """Pin the validated state and the locked inode for one synthetic attempt."""
    def snapshot():
        journal._require_open()
        def read_fd(fd):
            journal._check_file(fd)
            before = os.fstat(fd)
            key = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid,
                             s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if before.st_size > LIMIT:
                raise EpochError('journal file too large')
            data = os.pread(fd, LIMIT + 1, 0)
            if key(before) != key(os.fstat(fd)) or len(data) != before.st_size:
                raise EpochError('unstable journal file')
            return key(before), data
        statefd = os.open('state.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=journal.dirfd)
        try:
            state_file = read_fd(statefd)
        finally:
            os.close(statefd)
        lockfd = os.open('lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=journal.dirfd)
        try:
            lock_file = read_fd(lockfd)
            if lock_file != read_fd(journal.lockfd):
                raise EpochError('locked journal path changed')
            # This independent shared lock succeeds if no exclusive lock is held,
            # including when the original lock was downgraded. Never accept it.
            try:
                fcntl.flock(lockfd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
            else:
                journal.failed = True
                raise EpochError('journal lock is not held')
            # A competitor could have caused the conflict. Verify the original
            # description too, without waiting or accepting a competing owner.
            try:
                fcntl.flock(journal.lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                journal.failed = True
                raise EpochError('journal lock ownership lost') from exc
        finally:
            os.close(lockfd)
        return state_file, lock_file

    before = snapshot()
    state = _state(journal, ('rollback',))
    if snapshot() != before:
        raise EpochError('journal changed while pinning')

    def check():
        if snapshot() != before or _state(journal, ('rollback',)) != state or snapshot() != before:
            raise EpochError('pinned journal changed')
    return state, check


@dataclass(frozen=True)
class Resolution:
    operation: str
    evidence_digest: str
    identity: Identity
    original_intent_identity: tuple
    number: int
    prior: tuple
    mount_id: str
    destination_identity: tuple
    fence_sha256: str
    original_intent_contents: bytes
    prior_intents: tuple
    failure_markers: tuple


def attempt(journal, *, evidence_digest, mount_id, number, authority, fence, effect,
            original_intent_identity=None, destination_identity=None, resolve_prior=None,
            original_intent_contents=None, prior_intents=None):
    """Require synthetic external resolution before every effect, including replay."""
    state, check_journal = pin_journal(journal)
    if not isinstance(evidence_digest, str) or not re.fullmatch(r'[0-9a-f]{64}', evidence_digest):
        raise EpochError('invalid evidence digest')
    if not isinstance(mount_id, str) or not mount_id.strip() or len(mount_id) > 512:
        raise EpochError('invalid mount identity')
    if type(number) is not int or not 1 <= number <= 999999:
        raise EpochError('invalid epoch number')
    if (not callable(resolve_prior) or type(original_intent_identity) is not tuple
            or len(original_intent_identity) != 5
            or any(type(v) is not int or v < 0 for v in original_intent_identity)
            or original_intent_identity[2] == 0
            or type(destination_identity) is not tuple or len(destination_identity) != 3
            or any(type(v) is not int or v < 0 for v in destination_identity[:2])
            or not isinstance(destination_identity[2], str) or not destination_identity[2].strip()):
        raise EpochError('resolution bindings required')
    # The wrapper must safely read these bytes under its own identity checks.
    # Reject mutable containers and ambiguous or incomplete prior intent lists.
    if (type(original_intent_contents) is not bytes
            or len(original_intent_contents) != original_intent_identity[2]
            or type(prior_intents) is not tuple
            or any(type(item) is not tuple or len(item) != 2
                   or type(item[0]) is not str or not item[0]
                   or (item[1] is not None and type(item[1]) is not bytes)
                   for item in prior_intents)
            or len({item[0] for item in prior_intents}) != len(prior_intents)):
        raise EpochError('immutable intent contents required')
    lease = fence()
    if not isinstance(lease, str) or not lease.strip() or len(lease) > 1024:
        raise EpochError('invalid fence')
    operation = state['operation_id']

    def check():
        if fence() != lease or _state(journal, ('rollback',)) != state:
            raise EpochError('fence or journal changed')
        identity = authority(operation, evidence_digest)
        if type(identity) is not Identity:
            raise EpochError('ambiguous authority')
        identity.validate()
        check_journal()
        return identity

    identity = check()
    binding = {'operation': operation, 'evidence_sha256': evidence_digest, 'identity': asdict(identity),
               'original_intent_identity': list(original_intent_identity),
               'original_intent_sha256': hashlib.sha256(original_intent_contents).hexdigest(),
               'destination_identity': list(destination_identity)}
    record = dict(binding, version=1, number=number, mount_id=mount_id,
                  fence_sha256=hashlib.sha256(lease.encode('utf-8')).hexdigest())
    payload = _raw(record)
    if len(payload) > LIMIT:
        raise EpochError('epoch too large')
    entries = os.listdir(journal.dirfd)
    if any(n.startswith('.epoch-testonly-') and not n.startswith(FAILURE_PREFIX) for n in entries):
        journal.failed = True
        raise EpochError('unresolved temporary epoch evidence')
    failure_names = sorted(n for n in entries if n.startswith(FAILURE_PREFIX))
    failure_snapshots = tuple((name, _read(journal, name, True)) for name in failure_names)
    failure_markers = tuple((name, snapshot[1]) for name, snapshot in failure_snapshots)
    names = sorted(n for n in entries if n.startswith(PREFIX))
    expected = [PREFIX + f'{i:06d}.json' for i in range(1, len(names) + 1)]
    if names != expected or number not in (len(names), len(names) + 1):
        raise EpochError('ambiguous epoch sequence')
    prior = []
    prior_snapshots = []
    for i, name in enumerate(names, 1):
        snapshot = _read(journal, name, True)
        prior_snapshots.append((name, snapshot))
        raw = snapshot[1]
        try:
            old = json.loads(raw)
            if (not isinstance(old, dict) or set(old) != set(record) or _raw(old) != raw
                    or old['version'] != 1 or type(old['number']) is not int or old['number'] != i
                    or any(old[k] != v for k, v in binding.items())
                    or not isinstance(old['mount_id'], str) or not old['mount_id'].strip()
                    or not isinstance(old['fence_sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', old['fence_sha256'])):
                raise ValueError()
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise EpochError('invalid or mismatched epoch') from None
        if i == number and raw != payload:
            raise EpochError('epoch retry mismatch')
        prior.append((name, raw))
    if destination_identity[1] != identity.root_inode or destination_identity[2] != identity.volume:
        raise EpochError('destination identity mismatch')
    context = Resolution(operation, evidence_digest, identity, original_intent_identity,
                         number, tuple(prior), mount_id, destination_identity,
                         record['fence_sha256'], original_intent_contents, prior_intents,
                         failure_markers)
    if resolve_prior(context) is not True:
        raise EpochError('external resolution is required')
    if check() != identity or sorted(n for n in os.listdir(journal.dirfd) if n.startswith((PREFIX, '.epoch-testonly-'))) != sorted(names + failure_names):
        raise EpochError('journal or identity changed during resolution')
    if (tuple((name, _read(journal, name, True)) for name in names) != tuple(prior_snapshots)
            or tuple((name, _read(journal, name, True)) for name in failure_names) != failure_snapshots):
        raise EpochError('epoch evidence changed during resolution')
    if number == len(names) + 1:
        temp = '.epoch-testonly-' + uuid.uuid4().hex
        fd = None
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=journal.dirfd)
            journal._check_file(fd)
            view = memoryview(payload)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError('short epoch write')
                view = view[count:]
            os.fsync(fd)
            published_stat = os.fstat(fd)
            published_key = (published_stat.st_dev, published_stat.st_ino, published_stat.st_size,
                             published_stat.st_mtime_ns, published_stat.st_ctime_ns)
            os.close(fd)
            fd = None
            if check() != identity:
                raise EpochError('identity changed')
            _rename_noreplace(journal.dirfd, temp, PREFIX + f'{number:06d}.json')
            os.fsync(journal.dirfd)
        except BaseException:
            journal.failed = True
            # The rename or its reply can fail at any point. Keep either name
            # intact and try to make its directory entry durable.
            try:
                os.fsync(journal.dirfd)
            except BaseException:
                pass
            raise
        finally:
            if fd is not None:
                os.close(fd)
    try:
        if check() != identity:
            raise EpochError('identity changed')
        expected_prior = list(prior_snapshots)
        if number == len(names) + 1:
            # Rename can change ctime. Pin the published inode and its bytes.
            name = PREFIX + f'{number:06d}.json'
            published = _read(journal, name, True)
            if published[0][:3] != published_key[:3] or published[1] != payload:
                raise EpochError('published epoch identity changed')
            expected_prior.append((name, published))
        current_names = sorted(n for n in os.listdir(journal.dirfd) if n.startswith((PREFIX, '.epoch-testonly-')))
        expected_evidence = tuple(sorted(expected_prior + list(failure_snapshots)))
        if current_names != [name for name, _ in expected_evidence] or tuple((name, _read(journal, name, True)) for name in current_names) != expected_evidence:
            raise EpochError('epoch evidence changed before effect')
        if check() != identity:
            raise EpochError('fence, journal, or identity changed before effect')
        if (sorted(n for n in os.listdir(journal.dirfd) if n.startswith((PREFIX, '.epoch-testonly-'))) != current_names
                or tuple((name, _read(journal, name, True)) for name in current_names) != expected_evidence):
            raise EpochError('epoch evidence changed before effect')
        check_journal()
    except BaseException:
        journal.failed = True
        try:
            os.fsync(journal.dirfd)
        except BaseException:
            pass
        raise
    try:
        effect(context)
    except BaseException as error:
        journal.failed = True
        # A private marker remains for the resolver after reopen. Do not include
        # the exception message, which may contain secrets. Never delete a partial
        # marker: even a failed write is evidence of an uncertain effect.
        marker = FAILURE_PREFIX + uuid.uuid4().hex
        fd = None
        try:
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=journal.dirfd)
            journal._check_file(fd)
            data = _raw({'number': number, 'failure_type': type(error).__name__})
            view = memoryview(data)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError('short failure evidence write')
                view = view[count:]
            os.fsync(fd)
        finally:
            if fd is not None:
                os.close(fd)
            os.fsync(journal.dirfd)
        raise
