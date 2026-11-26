"""Experimental command adapter. It does not stop, start, or restore workloads.

The caller must durably record the original state and mask ownership BEFORE
calling mask(), hold the deployment lock, and provide the external physical
restart and Compose volume fence. Administrators must not change these settings
concurrently. The enablement tree must be trusted and complete; runtime unit
configuration is not supported. Never use this module as an automatic restore.
"""
import json
import os
import re
import subprocess


class AdapterError(Exception):
    """Sanitized failure; command output is never included."""


def _policy(value):
    if not isinstance(value, dict) or set(value) != {"Name", "MaximumRetryCount"}:
        raise AdapterError("Unsupported restart policy")
    name, count = value["Name"], value["MaximumRetryCount"]
    if name not in ("no", "always", "unless-stopped", "on-failure") or type(count) is not int or count < 0 or (name != "on-failure" and count != 0):
        raise AdapterError("Unsupported restart policy")
    return {"Name": name, "MaximumRetryCount": count}


class SystemdDockerAdapter:
    def __init__(self, runner=subprocess.run, enablement_root="/etc/systemd/system", owned_mask=False):
        if type(owned_mask) is not bool:
            raise AdapterError("Invalid mask ownership")
        self.runner = runner
        self.root = enablement_root
        self.owned_mask = owned_mask

    def _run(self, args):
        try:
            result = self.runner(args, capture_output=True, text=True, check=False, timeout=30)
            if result.returncode != 0 or not isinstance(result.stdout, str) or len(result.stdout) > 65536:
                raise ValueError()
            return result.stdout
        except Exception:
            raise AdapterError("Command failed") from None

    @staticmethod
    def _id(cid):
        if not isinstance(cid, str) or not re.fullmatch(r"[0-9a-f]{64}", cid):
            raise AdapterError("Invalid container ID")
        return cid

    def _enabled(self):
        # The caller supplies a trusted, complete persistent unit tree. Reject
        # non-symlink entries for this unit and filesystem traversal errors.
        found = False
        def fail(_error):
            raise AdapterError("Unit tree inspection failed")
        try:
            if not os.path.isdir(self.root) or os.path.islink(self.root):
                raise AdapterError("Unit tree inspection failed")
            for base, dirs, files in os.walk(self.root, followlinks=False, onerror=fail):
                if any(os.path.islink(os.path.join(base, d)) for d in dirs):
                    raise AdapterError("Ambiguous unit tree")
                if os.path.basename(base).endswith((".wants", ".requires")) and "pi-chat.service" in files:
                    path = os.path.join(base, "pi-chat.service")
                    if not os.path.islink(path) or os.path.basename(os.readlink(path)) != "pi-chat.service":
                        raise AdapterError("Ambiguous unit enablement")
                    found = True
            return found
        except OSError:
            raise AdapterError("Unit tree inspection failed") from None

    def unit_state(self):
        state = self._run(["systemctl", "show", "--property=UnitFileState", "--value", "pi-chat.service"])
        if state not in ("enabled\n", "disabled\n", "masked\n"):
            raise AdapterError("Unsupported unit state")
        enabled = self._enabled()
        if state != "masked\n" and enabled != (state == "enabled\n"):
            raise AdapterError("Ambiguous unit enablement")
        if state == "masked\n" and not self.owned_mask:
            raise AdapterError("Mask ownership not established")
        return {"enabled": enabled, "masked": state == "masked\n"}

    def mask(self):
        if not self.owned_mask:
            raise AdapterError("Mask ownership not established")
        before = self.unit_state()
        if not before["masked"]:
            self._run(["systemctl", "mask", "pi-chat.service"])
        if self.unit_state() != {"enabled": before["enabled"], "masked": True}:
            raise AdapterError("Mask verification failed")

    def unmask(self):
        if not self.owned_mask:
            raise AdapterError("Mask ownership not established")
        before = self.unit_state()
        if before["masked"]:
            self._run(["systemctl", "unmask", "pi-chat.service"])
        if self.unit_state() != {"enabled": before["enabled"], "masked": False}:
            raise AdapterError("Unmask verification failed")

    def policy(self, cid):
        cid = self._id(cid)
        output = self._run(["docker", "inspect", "--format", "{{json .HostConfig.RestartPolicy}}", cid])
        try:
            return _policy(json.loads(output))
        except (ValueError, TypeError, AdapterError):
            raise AdapterError("Invalid restart policy response") from None

    def set_policy(self, cid, policy):
        cid = self._id(cid)
        policy = _policy(policy)
        name = policy["Name"]
        value = name + (":" + str(policy["MaximumRetryCount"]) if name == "on-failure" and policy["MaximumRetryCount"] else "")
        self._run(["docker", "update", "--restart", value, cid])
        if self.policy(cid) != policy:
            raise AdapterError("Restart policy verification failed")
