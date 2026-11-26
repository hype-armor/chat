"""Private durable journal for an unimplemented username migration orchestrator.

No deployment actions are performed here. Hold Journal's lock for the entire
update or recovery, including all external effects. Use a dedicated, durable,
pre-created 0700 directory owned by the effective user. Never delete or replace
it during an operation. An independent supervisor must invoke recovery.

Each transition records intent BEFORE its corresponding effect. In particular,
commit_new must return successfully before any new ingress can open. If any
write or fsync fails, stop all effects and alert; reopen the journal to inspect
it. A failed write can nevertheless have published the new state. Filesystem and
hardware durability guarantees are outside this module's control.
"""
import fcntl
import hashlib
import json
import os
import stat
import uuid


class JournalError(RuntimeError):
    pass


PHASES = ('capture', 'fence', 'backup', 'migrate', 'start_new',
          'committed', 'complete', 'rollback', 'old_ready', 'rolled_back')
FORWARD = {'capture': 'fence', 'fence': 'backup', 'backup': 'migrate',
           'migrate': 'start_new', 'start_new': 'committed',
           'committed': 'complete', 'rollback': 'old_ready'}
MAX_SIZE = 4096


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def _validate(state):
    if not isinstance(state, dict) or set(state) != {'version', 'operation_id', 'phase', 'restore_required'}:
        raise JournalError('invalid journal schema')
    if type(state['version']) is not int or state['version'] != 1:
        raise JournalError('unsupported journal version')
    try:
        if not isinstance(state['operation_id'], str) or str(uuid.UUID(state['operation_id'])) != state['operation_id']:
            raise ValueError()
    except (ValueError, AttributeError):
        raise JournalError('invalid operation ID') from None
    if not isinstance(state['phase'], str) or state['phase'] not in PHASES:
        raise JournalError('invalid phase')
    restore = state['restore_required']
    if state['phase'] in ('rollback', 'old_ready', 'rolled_back'):
        if type(restore) is not bool:
            raise JournalError('invalid rollback state')
    elif restore is not None:
        raise JournalError('invalid restore flag')
    return state


class Journal:
    def __init__(self, directory):
        self.directory = os.fspath(directory)
        self.dirfd = None
        self.lockfd = None
        self.failed = False

    def __enter__(self):
        self.dirfd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(self.dirfd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise JournalError('journal directory must be owned by this user and mode 0700')
            self.lockfd = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.dirfd)
            self._check_file(self.lockfd)
            fcntl.flock(self.lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        if self.lockfd is not None:
            os.close(self.lockfd)
            self.lockfd = None
        if self.dirfd is not None:
            os.close(self.dirfd)
            self.dirfd = None

    @staticmethod
    def _check_file(fd):
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise JournalError('insecure journal file')

    def _require_open(self):
        if self.dirfd is None or self.lockfd is None:
            raise JournalError('journal lock is not held')
        if self.failed:
            raise JournalError('journal write failed; stop effects and reopen for recovery')

    def load(self):
        self._require_open()
        try:
            fd = os.open('state.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=self.dirfd)
        except FileNotFoundError:
            return None
        try:
            self._check_file(fd)
            data = os.read(fd, MAX_SIZE + 1)
            # A prior save can publish the new state but fail before its fsync
            # completes. Reopening must make that visible state durable before
            # any recovery action relies on it, especially the commit marker.
            try:
                os.fsync(fd)
                os.fsync(self.dirfd)
            except OSError:
                self.failed = True
                raise
        finally:
            os.close(fd)
        if len(data) > MAX_SIZE:
            raise JournalError('journal too large')
        try:
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError('duplicate key')
                    result[key] = value
                return result
            envelope = json.loads(data, object_pairs_hook=unique)
            if not isinstance(envelope, dict) or set(envelope) != {'state', 'sha256'}:
                raise ValueError('invalid envelope')
            state = _validate(envelope['state'])
            if envelope['sha256'] != hashlib.sha256(_canonical(state)).hexdigest():
                raise ValueError('checksum mismatch')
            return state
        except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
            raise JournalError('corrupt journal') from exc

    def _save(self, state):
        _validate(state)
        payload = _canonical({'state': state, 'sha256': hashlib.sha256(_canonical(state)).hexdigest()}) + b'\n'
        name = '.state-' + uuid.uuid4().hex
        fd = None
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.dirfd)
            view = memoryview(payload)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError('short journal write')
                view = view[count:]
            os.fsync(fd)
            os.close(fd)
            fd = None
            os.replace(name, 'state.json', src_dir_fd=self.dirfd, dst_dir_fd=self.dirfd)
            os.fsync(self.dirfd)
        except BaseException:
            self.failed = True
            raise
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(name, dir_fd=self.dirfd)
            except FileNotFoundError:
                pass

    def begin(self, operation_id):
        self._require_open()
        if self.load() is not None:
            raise JournalError('existing operation requires recovery')
        self._save({'version': 1, 'operation_id': operation_id, 'phase': 'capture', 'restore_required': None})

    def advance(self, phase):
        self._require_open()
        state = self.load()
        if state is None:
            raise JournalError('no operation')
        if FORWARD.get(state['phase']) != phase:
            raise JournalError('invalid or irreversible phase transition')
        state['phase'] = phase
        self._save(state)

    def begin_rollback(self):
        self._require_open()
        state = self.load()
        if state is None or state['phase'] not in ('capture', 'fence', 'backup', 'migrate', 'start_new'):
            raise JournalError('rollback not permitted')
        state['restore_required'] = state['phase'] in ('migrate', 'start_new')
        state['phase'] = 'rollback'
        self._save(state)

    def recovery_decision(self):
        """Return a plan label only. Never starts, restores, or opens anything.

        restore_old: fence all writers first, revalidate and restore the verified
        database and matching globals, then restore captured runtime and images.
        resume_old: old writes may have resumed; never restore again. Neither
        old_ready nor a legacy rolled_back record proves gate release occurred.
        Automatic gate release remains unavailable and requires separate proof.
        leave_new: no automatic restore, restart, or other action is allowed.
        Invalid or missing evidence must be handled as an operator alert.
        """
        state = self.load()
        if state is None:
            return 'no_operation'
        phase = state['phase']
        if phase in ('committed', 'complete'):
            return 'leave_new'
        if phase in ('old_ready', 'rolled_back'):
            return 'resume_old'
        if phase == 'rollback':
            return 'restore_old' if state['restore_required'] else 'recover_old_runtime'
        return 'begin_rollback'
