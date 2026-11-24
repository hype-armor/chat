"""Private fixture only. This adapter does not authorize live recovery.

The fixture owns its temporary directory and assumes no concurrent access or
untrusted code under the same UID. Reconciliation reports uncertain effects;
it never infers success or removes evidence.
"""
import json
import os
import re
import stat
import tempfile


class GateError(RuntimeError):
    pass


class FakeManager:
    """An in-memory test double. It cannot execute systemctl."""
    def __init__(self):
        self.loaded = None

    def reload(self, condition):
        self.loaded = condition

    def proves(self, condition):
        return self.loaded == condition


class Fixture:
    def __init__(self):
        self._temp = tempfile.TemporaryDirectory(prefix='permanent-gate-fixture-')
        self.path = self._temp.name
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        s = os.fstat(self.fd)
        if s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o700:
            raise GateError('fixture is not private')
        self.key = (s.st_dev, s.st_ino)

    def close(self):
        os.close(self.fd)
        self._temp.cleanup()

    def check(self):
        s = os.stat(self.path, follow_symlinks=False)
        if not stat.S_ISDIR(s.st_mode) or (s.st_dev, s.st_ino) != self.key or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o700:
            raise GateError('fixture path changed')


class Gate:
    def __init__(self, fixture, manager, checkpoint=lambda name: None, evidence=None):
        if type(fixture) is not Fixture or type(manager) is not FakeManager:
            raise GateError('private fixture and fake manager required')
        self.f = fixture
        self.manager = manager
        self.checkpoint = checkpoint
        self.evidence = evidence
        fixture.check()
        self.condition = 'ConditionPathExists=!%s/marker' % fixture.path
        self.drop = ('[Unit]\n' + self.condition + '\n').encode()

    def _read(self, name):
        self.f.check()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.f.fd)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o600 or s.st_size > 4096:
                raise GateError('untrusted fixture file')
            data = os.read(fd, 4097)
            t = os.fstat(fd)
            key = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
            if key(s) != key(t) or len(data) != s.st_size:
                raise GateError('file changed')
            os.fsync(fd)
            os.fsync(self.f.fd)
            return data, list(key(s))
        finally:
            os.close(fd)

    def _create(self, name, data):
        self.f.check()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.f.fd)
        try:
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                if n <= 0:
                    raise GateError('short write')
                view = view[n:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.f.fd)

    def _record(self, name, value):
        self._create(name, json.dumps(value, sort_keys=True, separators=(',', ':')).encode())

    def _get(self, name):
        try:
            return json.loads(self._read(name)[0])
        except (ValueError, TypeError) as exc:
            raise GateError('invalid proof') from exc

    def provision(self):
        # Never adopt an existing drop-in without its durable identity proof.
        try:
            proof = self._get('drop-proof')
        except FileNotFoundError:
            self._create('drop-in', self.drop)
            self.checkpoint('drop_created')
            data, key = self._read('drop-in')
            if data != self.drop:
                raise GateError('drop-in changed')
            self._record('drop-proof', key)
            proof = key
        if self._read('drop-in') != (self.drop, proof):
            raise GateError('drop-in identity changed')
        try:
            loaded = self._get('reload-proof')
        except FileNotFoundError:
            # An existing intent without proof is an ambiguous lost reply.
            self._record('reload-intent', {'condition': self.condition})
            self.manager.reload(self.condition)
            self.checkpoint('manager_reloaded')
            if not self.manager.proves(self.condition):
                raise GateError('manager did not load condition')
            self._record('reload-proof', {'condition': self.condition})
            loaded = {'condition': self.condition}
        if loaded != {'condition': self.condition}:
            raise GateError('invalid reload proof')
        self._barrier()

    def _barrier(self):
        if self._read('drop-in') != (self.drop, self._get('drop-proof')) or not self.manager.proves(self.condition):
            raise GateError('missing permanent manager proof')

    def acquire(self, operation):
        if not isinstance(operation, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', operation):
            raise GateError('invalid operation')
        self._barrier()
        # This fixture is one-shot. Never create a marker over old evidence.
        for name in ('marker', 'marker-proof', 'boundary-proof', 'release-intent', 'release-proof'):
            try:
                os.stat(name, dir_fd=self.f.fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise GateError('prior operation evidence exists')
        data = operation.encode('ascii')
        self._create('marker', data)
        self.checkpoint('marker_created')
        actual, key = self._read('marker')
        if actual != data:
            raise GateError('marker changed')
        self._record('marker-proof', {'operation': operation, 'identity': key})
        self._barrier()

    def _marker_proof(self):
        proof = self._get('marker-proof')
        if (type(proof) is not dict or set(proof) != {'operation', 'identity'}
                or type(proof['operation']) is not str
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', proof['operation'])
                or type(proof['identity']) is not list or len(proof['identity']) != 5
                or any(type(value) is not int or value < 0 for value in proof['identity'])):
            raise GateError('invalid marker proof')
        return proof

    def _marker(self, operation):
        proof = self._marker_proof()
        if proof['operation'] != operation or self._read('marker') != (operation.encode('ascii'), proof['identity']):
            raise GateError('marker identity changed')
        return proof

    def _evidence(self, operation, boundary, runtime):
        if not callable(self.evidence):
            raise GateError('external evidence required')
        evidence = self.evidence(operation)
        if not isinstance(evidence, dict):
            raise GateError('invalid external evidence')
        self._validate_evidence(evidence, operation, boundary, runtime)
        try:
            return json.loads(json.dumps(evidence, sort_keys=True, allow_nan=False))
        except (TypeError, ValueError) as exc:
            raise GateError('invalid external evidence') from exc

    def _validate_evidence(self, evidence, operation, boundary, runtime):
        if (type(evidence) is not dict or boundary not in ('old_ready', 'committed') or evidence.get('operation') != operation
                or evidence.get('phase') != boundary or evidence.get('runtime') != runtime
                or evidence.get('runtime_compatible') is not True
                or not isinstance(evidence.get('writers'), list)
                or not evidence['writers'] or any(not isinstance(w, str) or not w for w in evidence['writers'])
                or evidence.get('continuous_fence') is not True
                or not isinstance(evidence.get('fence_id'), str) or not evidence['fence_id']):
            raise GateError('external evidence does not prove boundary')

    def _validate_record(self, record, marker):
        if (type(record) is not dict or set(record) != {'operation', 'boundary', 'runtime', 'marker', 'evidence'}
                or record['operation'] != marker['operation'] or record['marker'] != marker
                or type(record['boundary']) is not str or record['boundary'] not in ('old_ready', 'committed')
                or type(record['runtime']) is not str or not record['runtime'] or len(record['runtime']) > 256):
            raise GateError('invalid release record')
        self._validate_evidence(record['evidence'], record['operation'], record['boundary'], record['runtime'])

    def boundary(self, operation, boundary, runtime):
        if boundary not in ('old_ready', 'committed') or not isinstance(runtime, str) or not runtime or len(runtime) > 256:
            raise GateError('invalid synthetic boundary')
        self._barrier()
        marker = self._marker(operation)
        evidence = self._evidence(operation, boundary, runtime)
        self._barrier()
        if self._marker(operation) != marker:
            raise GateError('marker identity changed')
        self._record('boundary-proof', {'operation': operation, 'boundary': boundary, 'runtime': runtime, 'marker': marker, 'evidence': evidence})

    def release(self, operation, boundary, runtime):
        self._barrier()
        marker = self._marker(operation)
        evidence = self._evidence(operation, boundary, runtime)
        self._barrier()
        if self._marker(operation) != marker:
            raise GateError('marker identity changed')
        expected = {'operation': operation, 'boundary': boundary, 'runtime': runtime, 'marker': marker, 'evidence': evidence}
        if boundary not in ('old_ready', 'committed') or not runtime or self._get('boundary-proof') != expected:
            raise GateError('matching durable boundary required')
        # An existing intent is ambiguous, even if the marker still exists.
        self._record('release-intent', expected)
        self.checkpoint('release_intent_recorded')
        # The fixture is single-owner. No claim is made about concurrent access.
        self._barrier()
        if self._evidence(operation, boundary, runtime) != evidence:
            raise GateError('external evidence changed')
        self._barrier()
        if self._marker(operation) != marker:
            raise GateError('marker identity changed')
        os.unlink('marker', dir_fd=self.f.fd)
        self.checkpoint('marker_unlinked')
        os.fsync(self.f.fd)
        self.checkpoint('marker_removal_synced')
        self._record('release-proof', expected)

    def reconcile(self):
        """Report an interrupted release without inferring success or changing files."""
        try:
            intent = self._get('release-intent')
        except FileNotFoundError:
            return 'no-release-intent'
        marker = self._marker_proof()
        boundary = self._get('boundary-proof')
        self._validate_record(boundary, marker)
        self._validate_record(intent, marker)
        if intent != boundary:
            raise GateError('release intent differs from boundary')
        try:
            proof = self._get('release-proof')
        except FileNotFoundError:
            return 'uncertain'
        self._validate_record(proof, marker)
        if proof != intent:
            raise GateError('release proof differs from intent')
        try:
            os.stat('marker', dir_fd=self.f.fd, follow_symlinks=False)
        except FileNotFoundError:
            return 'released'
        raise GateError('marker exists after release proof')
