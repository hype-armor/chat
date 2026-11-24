"""Experimental systemd startup gate, independent of unit enablement or masks.

The permanent drop-in must already exist and be loaded before engagement.
The drop-in remains on release, but Docker restart policies, other writers,
and real reboot behavior remain unverified. Do not use this module to authorize
a live migration. Actual systemd Conditions output syntax is unverified; the
parser contract below describes only the experimental fake response format.

The caller holds the deployment lock. Root administrators and systemd are
trusted not to change files, reload the manager, or start units concurrently.
The marker directory and systemd drop-in directory must already exist, be
persistent, and have root-owned, non-writable ancestry. This module never stops
or starts a service. A failed call is not proof that the gate is engaged.

Recovery requires the same operation ID and an explicit resume=True.
Automatic release is disabled until a verified durable release protocol exists.
Forward release is unsupported.
"""
import ctypes
import os
import re
import stat
import subprocess


class GateError(Exception):
    pass


def _rename_noreplace(parent, source, destination):
    """Publish a completed file atomically, without hard-link crash states."""
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameat2
    except AttributeError:
        raise GateError('renameat2 is unavailable') from None
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(parent, os.fsencode(source), parent, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


class SystemdGate:
    UNIT = "pi-chat.service"
    MARKER = "/var/lib/pi-chat/username-migration-gate"
    DROPIN = "/etc/systemd/system/pi-chat.service.d/90-chat-maintenance.conf"

    def __init__(self, operation_id, *, runner=None, marker=None, dropin=None,
                 trusted_root="/"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", operation_id):
            raise GateError("Invalid operation ID")
        self.operation_id = operation_id
        self.marker = marker or self.MARKER
        self.dropin = dropin or self.DROPIN
        self.root = trusted_root
        self.runner = runner or self._run
        if runner is None and (marker is not None or dropin is not None or trusted_root != "/" or os.geteuid() != 0):
            raise GateError("Production gate requires root and fixed paths")
        for path in (self.marker, self.dropin, self.root):
            if not os.path.isabs(path) or path.startswith('//') or not re.fullmatch(r"/[A-Za-z0-9_./-]*", path) or os.path.normpath(path) != path:
                raise GateError("Unsafe path")
        if self.marker == '/' or self.dropin == '/':
            raise GateError("Unsafe path")
        if not all(os.path.commonpath((self.root, p)) == self.root for p in (self.marker, self.dropin)):
            raise GateError("Path outside trusted root")
        self.marker_data = (operation_id + "\n").encode()
        self.dropin_data = ("[Unit]\nConditionPathExists=!" + self.marker + "\n").encode()

    @staticmethod
    def _run(args):
        if not os.path.isdir("/run/systemd/system"):
            raise GateError("System manager unavailable")
        result = subprocess.run(["systemctl", "--system", *args], check=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return result.stdout

    def _parent(self, path):
        # Open every component without following links. The caller supplies the
        # trust anchor only in tests; production always starts at filesystem root.
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = os.path.relpath(os.path.dirname(path), self.root).split("/")
            for part in ["."] + ([] if parts == ["."] else parts):
                if part != ".":
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = child
                s = os.fstat(fd)
                if s.st_uid != os.geteuid() or s.st_mode & 0o022:
                    raise GateError("Unsafe directory")
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _read(self, path, expected):
        parent = self._parent(path)
        try:
            fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                s = os.fstat(fd)
                if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o022 or s.st_nlink != 1 or s.st_size != len(expected):
                    raise GateError("Unsafe gate file")
                if os.read(fd, len(expected) + 1) != expected:
                    raise GateError("Unexpected gate file")
                # A prior publication can have succeeded before its fsync
                # failed. Make the existing file and name durable on retry.
                os.fsync(fd)
                os.fsync(parent)
                return (s.st_dev, s.st_ino)
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def _create(self, path, data):
        parent = self._parent(path)
        name = os.path.basename(path)
        temp = '.gate-' + os.urandom(16).hex()
        created = False
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            created = True
            try:
                with os.fdopen(fd, 'wb', closefd=False) as f:
                    f.write(data)
                    f.flush()
                    os.fsync(fd)
                    s = os.fstat(fd)
                    identity = (s.st_dev, s.st_ino)
            finally:
                os.close(fd)
            _rename_noreplace(parent, temp, name)
            created = False
            os.fsync(parent)
            return identity
        finally:
            try:
                if created:
                    try:
                        os.unlink(temp, dir_fd=parent)
                        os.fsync(parent)
                    except FileNotFoundError:
                        pass
            finally:
                os.close(parent)

    def _exists(self, path):
        parent = self._parent(path)
        try:
            try:
                os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)
                return True
            except FileNotFoundError:
                return False
        finally:
            os.close(parent)

    def _verify_manager(self):
        out = self.runner(["show", self.UNIT, "--property=LoadState", "--property=FragmentPath", "--property=DropInPaths", "--property=Conditions"])
        props = {}
        for line in out.splitlines():
            key, sep, value = line.partition("=")
            if not sep or key in props:
                raise GateError("Invalid manager response")
            props[key] = value
        fragment = props.get("FragmentPath", "")
        dropins = props.get("DropInPaths", "").split()
        def normalized_absolute(path):
            return (path.startswith('/') and not path.startswith('//')
                    and os.path.normpath(path) == path)

        if (props.get("LoadState") != "loaded"
                or not normalized_absolute(fragment)
                or not fragment.startswith(("/etc/systemd/system/", "/usr/lib/systemd/system/", "/lib/systemd/system/"))
                or any(not normalized_absolute(p) or p == '/run' or p.startswith('/run/') for p in dropins)):
            raise GateError("Unit is not persistently loaded")
        if self.dropin not in dropins:
            raise GateError("Drop-in is not loaded")
        conditions = props.get("Conditions", "")
        # Fake-response contract: one or more whitespace-separated braced
        # entries, each with exactly type, trigger, negate, path and state.
        # Fields use key=value with semicolon separators, in any order. Type
        # is a Condition identifier, path is an absolute normalized safe path,
        # booleans are yes/no, and state is succeeded/failed/untested. No empty,
        # duplicate, unknown or malformed fields are accepted. This is not a
        # verified contract for actual systemd output.
        # Ordinary conditions are ANDed; triggers are ORed with other triggers.
        entries = re.findall(r"\{([^{}]*)\}", conditions)
        if not re.fullmatch(r"\s*\{[^{}]*\}(?:\s+\{[^{}]*\})*\s*", conditions):
            raise GateError("Invalid conditions response")
        found = False
        for entry in entries:
            fields = {}
            for item in entry.split(";"):
                key, sep, value = item.strip().partition("=")
                if not sep or not key or key in fields:
                    raise GateError("Invalid condition fields")
                fields[key] = value.strip()
            if (set(fields) != {"type", "trigger", "negate", "path", "state"}
                    or not re.fullmatch(r"Condition[A-Za-z0-9]+", fields["type"])
                    or fields["trigger"] not in {"yes", "no"}
                    or fields["negate"] not in {"yes", "no"}
                    or fields["state"] not in {"succeeded", "failed", "untested"}
                    or not re.fullmatch(r"/[A-Za-z0-9_./-]*", fields["path"])
                    or fields["path"].startswith('//')
                    or os.path.normpath(fields["path"]) != fields["path"]):
                raise GateError("Invalid condition fields")
            if fields["type"] == "ConditionPathExists" and fields["path"] == self.marker:
                if fields.get("trigger") != "no" or fields.get("negate") != "yes":
                    raise GateError("Marker condition is not mandatory")
                found = True
        if not found:
            raise GateError("Condition is not loaded")

    def engage(self, *, resume=False):
        try:
            marker_exists = self._exists(self.marker)
            if not resume and marker_exists:
                raise GateError("Gate marker already exists")
            if resume and not marker_exists:
                raise GateError("Marker missing; publication outcome is ambiguous")
            # Installation and manager reload are separate administrative steps.
            # Verify both before publishing anything.
            dropin_id = self._read(self.dropin, self.dropin_data)
            self._verify_manager()
            if self._read(self.dropin, self.dropin_data) != dropin_id:
                raise GateError("Drop-in changed")
            if marker_exists:
                marker_id = self._read(self.marker, self.marker_data)
            else:
                marker_id = self._create(self.marker, self.marker_data)
                if self._read(self.marker, self.marker_data) != marker_id:
                    raise GateError("Marker changed during publication")
            self._verify_manager()
            if self._read(self.marker, self.marker_data) != marker_id or self._read(self.dropin, self.dropin_data) != dropin_id:
                raise GateError("Gate file changed")
        except GateError:
            raise
        except Exception:
            raise GateError("Gate engagement failed") from None

    def engage_initial(self):
        """Engage before fence intent exists; recovery requires explicit resume."""
        self.engage(resume=False)

    def verify(self):
        """Verify the persistent marker, drop-in and loaded manager state."""
        try:
            marker = self._read(self.marker, self.marker_data)
            dropin = self._read(self.dropin, self.dropin_data)
            self._verify_manager()
            if (self._read(self.marker, self.marker_data) != marker
                    or self._read(self.dropin, self.dropin_data) != dropin):
                raise GateError('Gate file changed')
            return True
        except GateError:
            raise
        except Exception:
            raise GateError('Gate verification failed') from None

    def clear_old_ready(self, journal):
        """Fail closed until a durable, verified release protocol exists."""
        # No independently verified durable release intent exists yet. In
        # particular, old_ready alone cannot authorize or reconcile removal.
        raise GateError('Automatic release disabled; durable release proof unavailable')
