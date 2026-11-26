"""Disposable PostgreSQL marker experiment. Not a live migration gate.

Fresh bootstrap, continuous external fencing, work ordering, and the independent
reconciliation verifier are trusted assumptions, not guarantees of this model.
The PostgreSQL advisory lock does not fence remote storage. Same-UID processes
and the binary installation must be trusted. Uncertain results are failure.
Clean startup requires a separate durable attestation bound to the run, fence,
proof digest, and independent verifier. The test fixture models this authority;
it is not a production authority or an atomic transaction with PostgreSQL.
The model assumes durable fsync and rename, no rollback, no tampering, and a
trusted host. Filesystem or host failures can break those assumptions. A failed
or lost clean database reply cannot publish an attestation. Ambiguous external
publication requires verification of the durable record, not trust in a reply.
Recovery of a possibly committed clean database reply without a matching durable
attestation is unsupported. Startup rejects it, even with an accepting verifier.
Path identity checks do not prevent transient substitution; trusted directory
ancestry, same-UID processes, filesystem semantics, and storage are required.
Pipe and process waits have deadlines. A hung filesystem or uninterruptible
process cannot be guaranteed to recover or terminate within those deadlines.
"""
import fcntl
import hashlib
import json
import os
import stat
import secrets
import select
import selectors
import subprocess
import tempfile
import time
import uuid

from isolated_pg_supervisor import IsolatedPostgres


DIAGNOSTIC_LIMIT = 65536
OUTPUT_LIMIT = 65536
# Each file reserves its full allowance. Same-UID peers must not remove evidence.
EVIDENCE_BUDGET = 16 * DIAGNOSTIC_LIMIT


class Rejected(RuntimeError):
    pass


class Experiment:
    def __init__(self, cluster, *, reconciliation_verifier=None, attestation=None, query_timeout=5):
        if type(cluster) is not IsolatedPostgres or cluster.closed or cluster.root is None:
            raise Rejected('fresh isolated cluster required')
        if query_timeout <= 0:
            raise ValueError('positive query timeout required')
        self.cluster = cluster
        self.verifier = reconciliation_verifier
        self.attestation = attestation
        self.query_timeout = query_timeout
        self.run_id = None
        self.fence = None
        self.failed = False
        self._buffer = b''
        self._diagnostic_bytes = 0
        self._diagnostic_overflow = False
        self._stderr_eof = False
        cluster.check()
        cluster._probe()
        # Reserve a full file allowance under a cross-process lock. Never delete evidence.
        lock_path = os.path.join(cluster.parent, '.marker-evidence-lock')
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            count = 0
            for entry in os.scandir(cluster.parent):
                if entry.name.startswith('marker-evidence-'):
                    info = entry.stat(follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_size > DIAGNOSTIC_LIMIT:
                        raise Rejected('invalid retained evidence')
                    count += 1
            if (count + 1) * DIAGNOSTIC_LIMIT > EVIDENCE_BUDGET:
                raise Rejected('evidence retention budget exhausted')
            self.evidence = tempfile.NamedTemporaryFile(mode='w+b', prefix='marker-evidence-',
                                                        dir=cluster.parent, delete=False)
        finally:
            os.close(lock_fd)
        self.evidence_path = self.evidence.name
        try:
            os.fchmod(self.evidence.fileno(), 0o600)
            self.proc = subprocess.Popen([cluster._bin('psql'), '-X', '-qAt', '-w',
                                         '-v', 'ON_ERROR_STOP=1'],
                                        env=cluster._environment(), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        bufsize=0)
            for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                os.set_blocking(pipe.fileno(), False)
            if self._query('SELECT pg_try_advisory_lock(77112001)') != ['t']:
                raise Rejected('another startup holds the lock')
        except BaseException:
            try:
                self.close()
            finally:
                self.evidence.close()
            raise

    def _capture_diagnostics(self):
        try:
            data = os.read(self.proc.stderr.fileno(), 4096)
        except BlockingIOError:
            return
        if not data:
            self._stderr_eof = True
            return
        remaining = DIAGNOSTIC_LIMIT - self._diagnostic_bytes
        if len(data) > remaining:
            self._diagnostic_overflow = True
            self.failed = True
        if data[:remaining]:
            self.evidence.write(data[:remaining])
            self.evidence.flush()
            self._diagnostic_bytes += len(data[:remaining])
        if self._diagnostic_overflow:
            raise Rejected('diagnostic output limit exceeded')

    def _query(self, sql):
        if self.failed or self.proc.poll() is not None:
            self.failed = True
            raise Rejected('connection lost or result ambiguous')
        sentinel = 'end_' + secrets.token_hex(16)
        try:
            self.cluster.check()
            request = (sql + ';\n\\echo ' + sentinel + '\n').encode()
            deadline = time.monotonic() + self.query_timeout
            result = []
            total = len(self._buffer)
            with selectors.DefaultSelector() as selector:
                selector.register(self.proc.stdin, selectors.EVENT_WRITE, 'stdin')
                selector.register(self.proc.stdout, selectors.EVENT_READ, 'stdout')
                if not self._stderr_eof:
                    selector.register(self.proc.stderr, selectors.EVENT_READ, 'stderr')
                done = False
                while not done:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise Rejected('query timeout')
                    events = selector.select(remaining)
                    if not events:
                        raise Rejected('query timeout')
                    for key, _ in events:
                        if key.data == 'stdin':
                            sent = os.write(key.fd, request)
                            request = request[sent:]
                            if not request:
                                selector.unregister(key.fileobj)
                        elif key.data == 'stderr':
                            self._capture_diagnostics()
                            if self._stderr_eof:
                                selector.unregister(key.fileobj)
                        else:
                            chunk = os.read(key.fd, 4096)
                            if not chunk:
                                raise Rejected('connection lost')
                            total += len(chunk)
                            if total > OUTPUT_LIMIT:
                                raise Rejected('query output limit exceeded')
                            self._buffer += chunk
                            while b'\n' in self._buffer:
                                line, self._buffer = self._buffer.split(b'\n', 1)
                                line = line.decode('utf-8')
                                if line == sentinel:
                                    done = True
                                    break
                                result.append(line)
                # Drain diagnostics already available before accepting the reply.
                while not self._stderr_eof and select.select([self.proc.stderr], [], [], 0)[0]:
                    if time.monotonic() >= deadline:
                        raise Rejected('query timeout')
                    if self.proc.poll() is not None:
                        raise Rejected('connection lost')
                    self._capture_diagnostics()
            self.cluster.check()
            return result
        except BaseException as exc:
            self.failed = True
            raise Rejected('connection lost or result ambiguous') from exc

    def _locked(self):
        rows = self._query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' "
                           "AND pid=pg_backend_pid() AND granted AND classid=0 "
                           "AND objid=77112001 AND objsubid=1")
        if rows != ['1']:
            self.failed = True
            raise Rejected('lock lost')

    def bootstrap(self):
        """Initialize only when an external authority establishes freshness."""
        self._locked()
        self._query("CREATE TABLE dirty_marker_testonly (singleton boolean PRIMARY KEY "
                    "CHECK (singleton), state text NOT NULL CHECK (state IN ('clean','dirty','pending')), "
                    "run_id uuid, fence uuid, proof_hash text); "
                    "INSERT INTO dirty_marker_testonly VALUES (true,'clean',NULL,NULL,NULL)")
        if self.attestation is None:
            raise Rejected('external attestation required')
        self.attestation.publish_bootstrap()

    def start(self):
        self._locked()
        if self.run_id is not None:
            raise Rejected('run already started')
        rows = self._query("SELECT state, coalesce(run_id::text,''), coalesce(fence::text,''), "
                           "coalesce(proof_hash,'') "
                           "FROM dirty_marker_testonly WHERE singleton")
        if len(rows) != 1:
            raise Rejected('marker unavailable')
        parts = rows[0].split('|')
        if len(parts) != 4 or parts[0] != 'clean' or self.attestation is None:
            raise Rejected('clean attestation required')
        if not self.attestation.verify(parts[1], parts[2], parts[3], self.verifier):
            raise Rejected('clean attestation required')
        run_id, fence = str(uuid.uuid4()), str(uuid.uuid4())
        rows = self._query("UPDATE dirty_marker_testonly SET state='dirty', run_id='" + run_id +
                           "', fence='" + fence + "', proof_hash=NULL WHERE singleton AND state='clean' RETURNING run_id::text")
        if rows != [run_id]:
            raise Rejected('dirty or ambiguous startup')
        self.run_id, self.fence = run_id, fence
        return run_id

    def finish(self, run_id, *, drain_confirmed):
        """Record a pending drain. This never makes the marker clean."""
        self._locked()
        if not drain_confirmed or self.run_id is None or run_id != self.run_id:
            raise Rejected('same-run confirmed drain required')
        rows = self._query("UPDATE dirty_marker_testonly SET state='pending' WHERE singleton "
                           "AND state='dirty' AND run_id='" + self.run_id + "'::uuid AND fence='" +
                           self.fence + "'::uuid RETURNING run_id::text")
        if rows != [self.run_id]:
            raise Rejected('marker mismatch or ambiguous result')

    def authorize_dirty_reconciliation(self, run_id, fence, proof):
        """Record an independently verified dirty-run recovery as pending."""
        self._locked()
        run_id, fence = self._verify_proof(run_id, fence, proof)
        rows = self._query("UPDATE dirty_marker_testonly SET state='pending' WHERE singleton "
                           "AND state='dirty' AND run_id='" + run_id + "'::uuid AND fence='" +
                           fence + "'::uuid RETURNING run_id::text")
        if rows != [run_id]:
            raise Rejected('marker mismatch or ambiguous result')

    def _verify_proof(self, run_id, fence, proof):
        try:
            run_id, fence = str(uuid.UUID(run_id)), str(uuid.UUID(fence))
        except (ValueError, TypeError, AttributeError) as exc:
            raise Rejected('invalid run or fence') from exc
        if self.verifier is None or self.verifier(run_id, fence, proof) is not True:
            raise Rejected('independent reconciliation proof required')
        return run_id, fence

    def reconcile(self, run_id, fence, proof):
        """Require a separately trusted verifier, including after a restart.

        The verifier must independently check proof against this run and fence.
        Its authenticity, freshness, fencing and ordering are external assumptions.
        """
        self._locked()
        run_id, fence = self._verify_proof(run_id, fence, proof)
        proof_hash = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':'),
                                              allow_nan=False).encode()).hexdigest()
        rows = self._query("UPDATE dirty_marker_testonly SET state='clean', proof_hash='" + proof_hash + "' WHERE singleton "
                           "AND state='pending' AND run_id='" + run_id + "'::uuid AND fence='" +
                           fence + "'::uuid RETURNING run_id::text")
        if rows != [run_id]:
            raise Rejected('marker mismatch or ambiguous result')
        if self.attestation is None:
            raise Rejected('external attestation required')
        try:
            self.attestation.publish(run_id, fence, proof, proof_hash)
        except BaseException:
            self.failed = True
            raise
        self.run_id = self.fence = None

    def close(self):
        if getattr(self, 'proc', None) is not None and not self.proc.stdin.closed:
            try:
                if self.proc.poll() is None:
                    self.proc.terminate()
                    try:
                        self.proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                        try:
                            self.proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            self.failed = True
                            raise Rejected('process did not terminate after kill')
                while select.select([self.proc.stderr], [], [], 0)[0]:
                    # EOF is always readable; stop when there are no bytes.
                    data = os.read(self.proc.stderr.fileno(), 4096)
                    if not data:
                        break
                    remaining = DIAGNOSTIC_LIMIT - self._diagnostic_bytes
                    self.evidence.write(data[:remaining])
                    self._diagnostic_bytes += len(data[:remaining])
                    if len(data) > remaining:
                        self._diagnostic_overflow = self.failed = True
                        break
                self.evidence.flush()
            finally:
                self.proc.stdin.close()
                self.proc.stdout.close()
                self.proc.stderr.close()
        # The caller owns the evidence handle and retention decision.
        if self._diagnostic_overflow:
            raise Rejected('diagnostic output limit exceeded')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
