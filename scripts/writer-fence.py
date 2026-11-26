"""Experimental writer-fence intent primitive. NOT a deployment fence.

This module has no live Docker backend. Its injected backend interface exists for
mock tests only. It cannot establish exclusive control of a Docker daemon or
prove that all database writers are stopped. Never use it to authorize a backup,
migration, restore, or new ingress. A complete implementation needs an external
exclusive supervisor, verified deployment identity, and a reviewed recovery plan.
HBA includes, external role settings, and all other real configurations are
unsupported. The Compose role can be a superuser; password rotation alone is not
a fence. A trusted supervisor must keep the normal stack stopped throughout the
component and migration. This module cannot prevent a later restart. No live
secrets are inspected or printed by this module.
"""
import fcntl
import json
import os
import re
import secrets
import stat


class FenceError(RuntimeError):
    pass


def _valid_image(value):
    # Docker's immutable local image ID, captured from the original container.
    return isinstance(value, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', value)


def _valid_name(value):
    return isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', value)


def _check_file(fd):
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        raise FenceError('insecure private file')


class Intent:
    """Persist one immutable rotation intent under an exclusive directory lock.

    The intent contains the replacement credential. Keep this directory private,
    durable, and outside backups available to writers. Never discard an intent
    after an uncertain effect. Retry only with the same backend target.
    """
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
                raise FenceError('intent directory must be owned by this user and mode 0700')
            self.lockfd = os.open('writer-fence.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.dirfd)
            _check_file(self.lockfd)
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

    def _ready(self):
        if self.dirfd is None or self.lockfd is None or self.failed:
            raise FenceError('intent lock unavailable; reopen and inspect')

    def load(self):
        self._ready()
        try:
            fd = os.open('writer-fence-intent.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=self.dirfd)
        except FileNotFoundError:
            return None
        try:
            _check_file(fd)
            data = os.read(fd, 4097)
            # A prior failed sync can leave a complete file visible in cache.
            # A retry must establish durability before it can use that intent.
            try:
                os.fsync(fd)
                os.fsync(self.dirfd)
            except OSError:
                self.failed = True
                raise
        finally:
            os.close(fd)
        try:
            if len(data) > 4096:
                raise ValueError('oversized')
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError('duplicate key')
                    result[key] = value
                return result
            state = json.loads(data, object_pairs_hook=unique)
            if (not isinstance(state, dict) or set(state) != {'version', 'image', 'volume', 'role', 'secret'}
                    or type(state['version']) is not int or state['version'] != 1
                    or not _valid_image(state['image']) or not _valid_name(state['volume'])
                    or not _valid_name(state['role']) or not isinstance(state['secret'], str)
                    or not re.fullmatch(r'[0-9a-f]{64}', state['secret'])):
                raise ValueError('invalid intent')
            return state
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise FenceError('invalid rotation intent') from exc

    def prepare(self, image, volume, role):
        self._ready()
        if not _valid_image(image) or not _valid_name(volume) or not _valid_name(role):
            raise FenceError('invalid pinned image, volume, or role')
        old = self.load()
        if old is not None:
            if (old['image'], old['volume'], old['role']) != (image, volume, role):
                raise FenceError('existing intent has a different target')
            return old
        state = {'version': 1, 'image': image, 'volume': volume, 'role': role,
                 'secret': secrets.token_hex(32)}
        payload = (json.dumps(state, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')
        # A direct O_EXCL write can leave a partial intent after a crash. That is
        # deliberately an operator stop, never permission to generate a new secret.
        fd = None
        try:
            fd = os.open('writer-fence-intent.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.dirfd)
            view = memoryview(payload)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError('short write')
                view = view[count:]
            os.fsync(fd)
            os.close(fd)
            fd = None
            os.fsync(self.dirfd)
        except BaseException:
            self.failed = True
            raise
        finally:
            if fd is not None:
                os.close(fd)
        return state


def test_only_rotate(intent, backend, image, volume, role):
    """Exercise intent ordering with a mock backend. This is not a real fence.

    preflight and rotate must be idempotent. The backend must raise on every
    unsupported or uncertain state. A real backend is intentionally absent.
    """
    if not getattr(backend, 'TEST_ONLY', False):
        raise FenceError('live writer fence is not implemented')
    if not _valid_image(image) or not _valid_name(volume) or not _valid_name(role):
        raise FenceError('invalid target')
    backend.preflight(image, volume, role)
    state = intent.prepare(image, volume, role)
    backend.rotate(state)
