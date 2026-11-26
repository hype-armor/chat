"""Offline primitives for update.sh's maintenance marker; no operational CLI.

The caller must hold the deployment lock throughout engagement and removal of
both gates. Publish this marker before engaging SystemdGate. On rollback, remove
this marker first and clear SystemdGate last, while still holding that lock.
The caller must verify old image, configuration and database compatibility before
recording old_ready. This module never restores data or releases a forward gate.
The directory must be persistent, private, and securely opened without symlinks
by the caller. Trusted administrators must not replace it or its contents.
"""
import ctypes
import os
import stat
import uuid


class UpdateGateError(Exception):
    pass


def _rename_noreplace(fd, source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameat2
    except AttributeError:
        raise UpdateGateError('renameat2 unavailable') from None
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(fd, os.fsencode(source), fd, os.fsencode(destination), 1):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


class UpdateGate:
    MARKER = 'maintenance-in-progress'

    def __init__(self, directory_fd, operation_id):
        try:
            if not isinstance(operation_id, str) or str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except (ValueError, AttributeError):
            raise UpdateGateError('invalid operation ID') from None
        info = os.fstat(directory_fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise UpdateGateError('unsafe marker directory')
        self.fd = directory_fd
        self.operation_id = operation_id
        self.data = (operation_id + '\n').encode('ascii')

    def _read(self):
        fd = os.open(self.MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self.fd)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                    or info.st_size != len(self.data) or os.read(fd, len(self.data) + 1) != self.data):
                raise UpdateGateError('unexpected marker')
            return info.st_dev, info.st_ino
        finally:
            os.close(fd)

    def engage(self, *, resume=False):
        """Publish a complete marker. Resume accepts only this operation's file."""
        if resume:
            try:
                self._read()
            except FileNotFoundError:
                pass
            else:
                os.fsync(self.fd)
                return
        name = '.maintenance-' + uuid.uuid4().hex
        created = False
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
            created = True
            try:
                view = memoryview(self.data)
                while view:
                    n = os.write(fd, view)
                    if n <= 0:
                        raise OSError('short marker write')
                    view = view[n:]
                os.fsync(fd)
            finally:
                os.close(fd)
            _rename_noreplace(self.fd, name, self.MARKER)
            created = False
            os.fsync(self.fd)
            self._read()
        finally:
            if created:
                os.unlink(name, dir_fd=self.fd)
                os.fsync(self.fd)

    def engage_initial(self):
        """Engage before fence intent exists, or resume a partial engagement."""
        self.engage(resume=True)

    def verify(self):
        """Verify this operation's marker and make its directory durable."""
        identity = self._read()
        os.fsync(self.fd)
        if self._read() != identity:
            raise UpdateGateError('marker changed')
        return True

    def clear_old_ready(self, journal):
        """Fail closed until a durable, verified release protocol exists."""
        # old_ready does not prove that this operation removed an absent gate.
        # The composed release protocol does not yet bind a validated Docker
        # intent to an independently trusted fence configuration. Fail closed.
        raise UpdateGateError('automatic release disabled; durable release proof unavailable')
