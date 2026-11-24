"""Restart fence primitives; no operational CLI or system command adapter.

The caller must hold the deployment lock and enforce the startup gate. The
adapter must inspect persistent (not runtime) systemd unit-file state, including
underlying enablement beneath a mask, and immutable Docker container IDs.
It must raise on every inspection or command error. Host and Docker administrators
are trusted not to change these settings concurrently.
"""

import json
import os
import re
import stat


class FenceError(Exception):
    """A safe, non-sensitive fence failure."""


def _policy(value):
    if not isinstance(value, dict) or set(value) != {"Name", "MaximumRetryCount"}:
        raise FenceError("Unsupported restart policy")
    name, count = value["Name"], value["MaximumRetryCount"]
    if name not in ("no", "always", "unless-stopped", "on-failure"):
        raise FenceError("Unsupported restart policy")
    if type(count) is not int or count < 0 or (name != "on-failure" and count != 0):
        raise FenceError("Unsupported restart policy")
    return {"Name": name, "MaximumRetryCount": count}


def _unit(value):
    if not isinstance(value, dict) or set(value) != {"enabled", "masked"}:
        raise FenceError("Unsupported unit state")
    if type(value["enabled"]) is not bool or type(value["masked"]) is not bool:
        raise FenceError("Unsupported unit state")
    return dict(value)


class RestartFence:
    """One operation's durable fence. Never performs a stop or a start.

    parent_fd is an already securely opened private directory. operation_id is
    unique for the deployment. adapter methods: unit_state(), policy(id),
    mask(), unmask(), set_policy(id, policy). The adapter must reject unknown,
    transient, runtime-only or ambiguous unit states and must not leak command
    output in exceptions. Container IDs must be full immutable hex IDs.

    verify_boundary(boundary) must verify the durable caller-owned boundary AND
    image/database compatibility, under the deployment lock, on every restore.
    It must return exactly True. No restore starts without this verification.
    """

    def __init__(self, parent_fd, operation_id, adapter):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", operation_id):
            raise FenceError("Invalid operation ID")
        self.adapter = adapter
        self.parent_fd = parent_fd
        self.operation_id = operation_id
        info = os.fstat(parent_fd)
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
            raise FenceError("Unsafe journal parent")
        try:
            os.mkdir(operation_id, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        except FileExistsError:
            pass
        self.fd = os.open(operation_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        info = os.fstat(self.fd)
        if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
            os.close(self.fd)
            raise FenceError("Unsafe journal directory")

    def close(self):
        os.close(self.fd)

    def _load(self):
        try:
            fd = os.open("intent.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_size > 65536:
                raise FenceError("Unsafe journal file")
            with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as f:
                data = json.load(f)
        except (ValueError, UnicodeError, OSError):
            raise FenceError("Invalid journal") from None
        finally:
            os.close(fd)
        if not isinstance(data, dict) or set(data) != {"version", "unit", "containers"} or data["version"] != 1:
            raise FenceError("Invalid journal")
        _unit(data["unit"])
        if not isinstance(data["containers"], dict) or not data["containers"]:
            raise FenceError("Invalid journal")
        for cid, policy in data["containers"].items():
            if not re.fullmatch(r"[0-9a-f]{64}", cid):
                raise FenceError("Invalid journal")
            _policy(policy)
        return data

    def _save(self, data):
        # A random O_EXCL name prevents following or replacing an attacker link.
        name = ".intent-" + os.urandom(16).hex()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as f:
                json.dump(data, f, sort_keys=True, separators=(",", ":"))
                f.flush()
                os.fsync(fd)
            os.link(name, "intent.json", src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
            os.fsync(self.fd)
        finally:
            os.close(fd)
            os.unlink(name, dir_fd=self.fd)
            os.fsync(self.fd)

    def engage(self, container_ids):
        """Capture intent before effects, then block and verify all starts."""
        try:
            ids = list(container_ids)
            if not ids or len(ids) != len(set(ids)) or any(not isinstance(i, str) or not re.fullmatch(r"[0-9a-f]{64}", i) for i in ids):
                raise FenceError("Invalid container IDs")
            data = self._load()
            if data is None:
                data = {"version": 1, "unit": _unit(self.adapter.unit_state()),
                        "containers": {i: _policy(self.adapter.policy(i)) for i in ids}}
                self._save(data)
            elif set(ids) != set(data["containers"]):
                raise FenceError("Container set differs from journal")
            # Always repeat these operations after a crash. Mask is persistent.
            self.adapter.mask()
            for cid in data["containers"]:
                self.adapter.set_policy(cid, {"Name": "no", "MaximumRetryCount": 0})
            if not _unit(self.adapter.unit_state())["masked"]:
                raise FenceError("Unit mask verification failed")
            for cid in data["containers"]:
                if _policy(self.adapter.policy(cid)) != {"Name": "no", "MaximumRetryCount": 0}:
                    raise FenceError("Restart policy verification failed")
        except FenceError:
            raise
        except Exception:
            raise FenceError("Fence operation failed") from None

    def restore(self, boundary, verify_boundary):
        """Restore exact original settings after caller verifies its boundary."""
        try:
            data = self._load()
            if data is None:
                raise FenceError("Missing journal")
            if boundary not in ("old_ready", "committed") or verify_boundary(boundary) is not True:
                raise FenceError("Boundary verification failed")
            # A partially completed restore is safe to retry only after the
            # caller verifies compatibility again. Restore mask last.
            for cid, policy in data["containers"].items():
                self.adapter.set_policy(cid, policy)
            for cid, policy in data["containers"].items():
                if _policy(self.adapter.policy(cid)) != policy:
                    raise FenceError("Restart policy verification failed")
            original = data["unit"]
            current = _unit(self.adapter.unit_state())
            if current["enabled"] != original["enabled"]:
                raise FenceError("Unit enablement changed")
            if original["masked"]:
                self.adapter.mask()
            else:
                self.adapter.unmask()
            if _unit(self.adapter.unit_state()) != original:
                raise FenceError("Unit state verification failed")
        except FenceError:
            raise
        except Exception:
            raise FenceError("Fence operation failed") from None
