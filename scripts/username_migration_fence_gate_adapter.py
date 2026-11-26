"""Experimental offline gate composition. This is not an operational adapter.

The caller holds the durable operation journal lock and the deployment lock
across every call. The fence directory must be persistent, private, and securely
opened. No administrator or other actor may modify the gates. This code does
not prove supervisor coverage, database compatibility, or host reboot safety.
Only injected test systemd runners and non-production marker paths are allowed.
Never use this adapter for a deployment.
"""
import json
import os
import stat

from username_migration_docker_fence import DOCKER_FENCE_INTENT_VERSION
from username_migration_systemd_gate import SystemdGate
from username_migration_update_gate import UpdateGate


class AdapterError(Exception):
    pass


class SyntheticFreshIntent:
    """Caller assertion for tests only; this is not evidence of a real fence."""
    def __init__(self, operation_id):
        self.operation_id = operation_id
        self.pid = os.getpid()
        self.used = False


class TestGateAdapter:
    """One DockerFence gate composed from the update and systemd primitives.

    The operation journal's fence phase is the durable intent for both gates.
    After Docker intent exists, missing gates are a breach, not an invitation to
    recreate them. The caller must not remove or replace either journal.
    """
    def __init__(self, journal, fence_fd, update_gate, systemd_gate):
        info = os.fstat(fence_fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise AdapterError('unsafe fence directory')
        if (not isinstance(update_gate, UpdateGate) or not isinstance(systemd_gate, SystemdGate)
                or update_gate.operation_id != systemd_gate.operation_id):
            raise AdapterError('gate operation mismatch')
        # Never permit the production runner or production systemd paths here.
        if (getattr(systemd_gate.runner, '__func__', systemd_gate.runner) is SystemdGate._run
                or systemd_gate.marker == SystemdGate.MARKER
                or systemd_gate.dropin == SystemdGate.DROPIN
                or systemd_gate.root == '/'):
            raise AdapterError('test systemd configuration required')
        self.journal, self.fd = journal, fence_fd
        self.update, self.systemd = update_gate, systemd_gate
        self.operation_id = update_gate.operation_id

    def fence_directory_identity(self):
        info = os.fstat(self.fd)
        return info.st_dev, info.st_ino

    def _state(self, phases):
        state = self.journal.load()
        if (not isinstance(state, dict) or state.get('operation_id') != self.operation_id
                or state.get('phase') not in phases):
            raise AdapterError('operation journal mismatch or invalid phase')
        return state

    def _docker_intent_exists(self):
        try:
            os.stat('docker-fence.json', dir_fd=self.fd, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def engage_initial(self, *, fresh_intent=None):
        self._state(('fence',))
        if (not isinstance(fresh_intent, SyntheticFreshIntent)
                or fresh_intent.operation_id != self.operation_id
                or fresh_intent.pid != os.getpid() or fresh_intent.used):
            raise AdapterError('synthetic fresh intent required')
        fresh_intent.used = True
        if self._docker_intent_exists():
            raise AdapterError('Docker intent already exists')
        self.update.engage(resume=True)
        self.systemd.engage_initial()
        self.verify()

    def engage(self, *, resume=False):
        if resume is not True:
            raise AdapterError('explicit resume required')
        self._state(('fence', 'rollback'))
        if self._docker_intent_exists():
            # Docker may have already changed restart policies or stopped units.
            self.verify()
            return
        # Recovery cannot create a missing systemd marker.
        self.systemd.engage(resume=True)
        self.update.engage(resume=True)
        self.verify()

    def _verify_docker_intent(self):
        try:
            fd = os.open('docker-fence.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            fd = None
        if fd is not None:
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                        or info.st_size > 65536):
                    raise ValueError()
                with os.fdopen(fd, 'r', closefd=False) as f:
                    data = json.load(f)
                if (not isinstance(data, dict) or data.get('version') != DOCKER_FENCE_INTENT_VERSION
                        or data.get('operation_id') != self.operation_id):
                    raise ValueError()
            except (ValueError, OSError, TypeError):
                raise AdapterError('invalid Docker fence intent') from None
            finally:
                os.close(fd)
    def verify(self):
        self._state(('fence', 'backup', 'migrate', 'start_new', 'rollback'))
        self._verify_docker_intent()
        if self.update.verify() is not True or self.systemd.verify() is not True:
            raise AdapterError('gate verification failed')
        return True

    def clear_old_ready(self):
        """Attempt release; gate primitives currently fail closed.

        Never restore data after old_ready, even if this method fails.
        """
        self._state(('old_ready',))
        self._verify_docker_intent()
        self.update.clear_old_ready(self.journal)
        self.systemd.clear_old_ready(self.journal)
