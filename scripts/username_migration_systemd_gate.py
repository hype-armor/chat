"""Persistent systemd startup gate, independent of unit enablement or masks.

The caller holds the deployment lock. Root administrators and systemd are
trusted not to change files, reload the manager, or start units concurrently.
The marker directory and systemd drop-in directory must already exist, be
persistent, and have root-owned, non-writable ancestry. This module never stops
or starts a service. A failed call is not proof that the gate is engaged.

Recovery requires the same operation ID and an explicit resume=True. A caller
must not clear after cutover failure. Forward release is deliberately unsupported:
a separate, reviewed contract must define that boundary first.
"""
import os
import re
import stat
import subprocess


class GateError(Exception):
    pass


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
            if not os.path.isabs(path) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", path) or os.path.normpath(path) != path:
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
                return (s.st_dev, s.st_ino)
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def _create(self, path, data, atomic=False):
        parent = self._parent(path)
        name = os.path.basename(path)
        temp = ".gate-" + os.urandom(16).hex() if atomic else name
        created = False
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            created = True
            try:
                with os.fdopen(fd, "wb", closefd=False) as f:
                    f.write(data)
                    f.flush()
                    os.fsync(fd)
            finally:
                os.close(fd)
            if atomic:
                os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                os.fsync(parent)
                os.unlink(temp, dir_fd=parent)
                created = False
            os.fsync(parent)
        finally:
            if atomic and created:
                try:
                    os.unlink(temp, dir_fd=parent)
                    os.fsync(parent)
                except FileNotFoundError:
                    pass
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
        if props.get("LoadState") != "loaded" or not fragment.startswith(("/etc/systemd/system/", "/usr/lib/systemd/system/", "/lib/systemd/system/")) or any(p.startswith("/run/") for p in dropins):
            raise GateError("Unit is not persistently loaded")
        if self.dropin not in dropins:
            raise GateError("Drop-in is not loaded")
        conditions = props.get("Conditions", "")
        pattern = r"\{\s*type=ConditionPathExists\s*;[^}]*\bnegate=yes\s*;[^}]*\bpath=" + re.escape(self.marker) + r"\s*;[^}]*\}"
        if not re.search(pattern, conditions):
            raise GateError("Condition is not loaded")

    def engage(self, *, resume=False):
        try:
            marker_exists = self._exists(self.marker)
            dropin_exists = self._exists(self.dropin)
            if not resume and (marker_exists or dropin_exists):
                raise GateError("Gate files already exist")
            if dropin_exists and not marker_exists:
                raise GateError("Marker missing")
            if marker_exists:
                self._read(self.marker, self.marker_data)
            else:
                self._create(self.marker, self.marker_data)
            if dropin_exists:
                self._read(self.dropin, self.dropin_data)
            else:
                self._create(self.dropin, self.dropin_data, atomic=True)
            marker_id = self._read(self.marker, self.marker_data)
            dropin_id = self._read(self.dropin, self.dropin_data)
            self.runner(["daemon-reload"])
            self._verify_manager()
            if self._read(self.marker, self.marker_data) != marker_id or self._read(self.dropin, self.dropin_data) != dropin_id:
                raise GateError("Gate file changed")
        except GateError:
            raise
        except Exception:
            raise GateError("Gate engagement failed") from None

    def clear_old_ready(self, verify_old_ready):
        """Release only after an independent locked old-image/database check."""
        try:
            if verify_old_ready() is not True:
                raise GateError("Old-ready boundary not verified")
            self._read(self.marker, self.marker_data)
            self._read(self.dropin, self.dropin_data)
            # Removing the marker releases the condition. Keep the owned drop-in
            # in place until after the manager has reloaded the removal.
            parent = self._parent(self.marker)
            try:
                os.unlink(os.path.basename(self.marker), dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(parent)
            parent = self._parent(self.dropin)
            try:
                os.unlink(os.path.basename(self.dropin), dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(parent)
            self.runner(["daemon-reload"])
        except GateError:
            raise
        except Exception:
            raise GateError("Gate release failed") from None
