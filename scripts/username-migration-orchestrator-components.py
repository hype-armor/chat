"""Incomplete migration components. There is no deployment entry point.

The physical fence, full backup/restore, blob consistency, and supervisor are
not implemented. These components must not authorize operations on /srv/chat.
"""
import importlib.util
import re
import subprocess
import uuid
from pathlib import Path

_spec = importlib.util.spec_from_file_location('migration_journal', Path(__file__).with_name('username-migration-journal.py'))
_journal = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_journal)


class Unavailable(RuntimeError):
    pass


class DockerImages:
    """Capture immutable local IDs and pin them with operation-specific tags.

    Pins are evidence and are never removed here. The caller must persist the
    returned manifest before relying on it. Docker daemon exclusivity is not
    established by these commands.
    """
    def __init__(self, run=subprocess.run):
        self.run = run

    def _call(self, args, capture=False):
        result = self.run(['docker', '--host', 'unix:///var/run/docker.sock', *args], check=True,
                          env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent',
                               'DOCKER_CONFIG': '/nonexistent', 'LC_ALL': 'C'},
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, text=True)
        return result.stdout.strip() if capture else None

    def capture_and_pin(self, operation_id, images):
        op = str(uuid.UUID(operation_id))
        if op != operation_id or not images:
            raise ValueError('invalid operation or empty image set')
        result = {}
        for name, reference in sorted(images.items()):
            if not re.fullmatch(r'[a-z][a-z0-9_-]{0,40}', name):
                raise ValueError('invalid service name')
            if not isinstance(reference, str) or not reference or reference.startswith('-') or any(c.isspace() for c in reference):
                raise ValueError('invalid image reference')
            image = self._call(['image', 'inspect', '--format', '{{.Id}}', reference], True)
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
                raise ValueError('invalid image ID')
            tag = 'chat-migration-evidence:' + op + '-' + name
            # Inspect first. A retry may reuse the same pin, but must not overwrite
            # a different pin. Daemon exclusivity remains an external requirement.
            try:
                existing = self._call(['image', 'inspect', '--format', '{{.Id}}', tag], True)
            except subprocess.CalledProcessError:
                existing = None
            if existing is not None and existing != image:
                raise ValueError('evidence pin already points to another image')
            if existing is None:
                self._call(['image', 'tag', image, tag])
            if self._call(['image', 'inspect', '--format', '{{.Id}}', tag], True) != image:
                raise ValueError('image pin verification failed')
            result[name] = {'id': image, 'pin': tag}
        return result


class Orchestrator:
    """Journal-driven coordinator for an injected, complete backend.

    verify_and_restore and restore_old_runtime must keep all old TCP credentials
    and ingress fenced. restore_old_runtime must not start a service. Recovery
    from old_ready must never restore data again. Automatic gate release is
    unavailable, including after the durable old_ready boundary.

    This build deliberately refuses all execution. Do not replace the guard
    until all physical preconditions and independent recovery are implemented.
    """
    def __init__(self, journal, backend):
        self.journal = journal
        self.backend = backend

    def _preflight(self):
        raise Unavailable('physical fence and full verified restore adapters are unavailable')

    def run(self, operation_id):
        self._preflight()  # No journal writes or deployment effects before this.
        self.journal.begin(operation_id)
        try:
            self._forward()
        except Exception:
            # A failed journal fsync may have published a commit. Never execute
            # recovery with a failed journal handle; reopen and inspect instead.
            if not self.journal.failed:
                self._recover()
            raise

    def recover(self):
        self._preflight()
        self._recover()

    def _forward(self):
        steps = [('capture', 'capture'), ('fence', 'fence'),
                 ('backup', 'backup'), ('migrate', 'migrate'),
                 ('start_new', 'start_new')]
        for index, (phase, method) in enumerate(steps):
            if index:
                self.journal.advance(phase)
            getattr(self.backend, method)()
            if phase == 'backup':
                # Verify before recording migrate intent: failed verification
                # must recover the untouched database without restoring it.
                self.backend.verify_recovery_set()
        # The backend must keep the durable writer and ingress fence in place
        # through this verification and the commit transition.
        self.backend.verify_recovery_set()
        self.journal.advance('committed')
        self.backend.open_new()
        self.journal.advance('complete')

    def _recover(self):
        state = self.journal.load()
        if state is None:
            return
        phase = state['phase']
        if phase in ('committed', 'complete'):
            # Leave the new service unchanged. This does not establish ingress health.
            return
        if phase in ('old_ready', 'rolled_back'):
            # Never restore after old_ready. Legacy rolled_back records do not
            # prove that the gates were released safely.
            raise Unavailable('recovery unresolved: automatic gate release is disabled')
        if phase != 'rollback':
            self.journal.begin_rollback()
            state = self.journal.load()
        self.backend.fence()
        if state['restore_required']:
            self.backend.verify_and_restore()
        self.backend.restore_old_runtime()
        # Record the no-more-restores boundary before starting any old runtime.
        # Existing TCP clients can otherwise reconnect before ingress opens.
        self.journal.advance('old_ready')
        raise Unavailable('recovery unresolved: automatic gate release is disabled')
