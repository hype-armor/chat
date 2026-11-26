"""Disposable-only integration tests. No live migration authorization."""
import os
import hashlib
import json
import select
import subprocess
import sys
import time
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from dirty_marker_testonly import Experiment, Rejected
from isolated_pg_supervisor import IsolatedPostgres


class FileAttestation:
    """Private fixture model, not an independent production authority.

    Verification fsyncs the opened file and its parent directory before use.
    It checks pathname identity before and after synchronization. This is not a
    defense against transient replacement: directory ancestry, same-UID processes,
    filesystem semantics, and storage must be trusted. No rollback or tampering is
    assumed. PostgreSQL and this file are not one transaction. A failed fsync
    rejects verification; later verification can establish durable publication.
    """
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / 'clean-attestation.json'

    def _publish(self, record):
        fd, name = tempfile.mkstemp(prefix='attestation-', dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(record, out)
                out.flush()
                os.fsync(out.fileno())
            os.replace(name, self.path)
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            # Keep an unpublished temporary file as evidence of a failed attempt.
            pass

    def publish_bootstrap(self):
        self._publish({'bootstrap': True})

    def publish(self, run, fence, proof, proof_hash):
        self._publish({'run': run, 'fence': fence, 'proof': proof, 'hash': proof_hash})

    def verify(self, run, fence, proof_hash, verifier):
        try:
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                directory = os.fstat(directory_fd)
                def same_directory():
                    current = os.stat(self.directory, follow_symlinks=False)
                    return (directory.st_dev, directory.st_ino) == (current.st_dev, current.st_ino)
                if not same_directory():
                    return False
                fd = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
                try:
                    opened = os.fstat(fd)
                    before = os.stat(self.path.name, dir_fd=directory_fd, follow_symlinks=False)
                    if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                        return False
                    with os.fdopen(fd, 'r', closefd=False) as source:
                        record = json.load(source)
                    os.fsync(fd)
                    os.fsync(directory_fd)
                    after = os.stat(self.path.name, dir_fd=directory_fd, follow_symlinks=False)
                    if (opened.st_dev, opened.st_ino) != (after.st_dev, after.st_ino):
                        return False
                    if not run and not fence and not proof_hash:
                        valid = record == {'bootstrap': True}
                    else:
                        proof = record['proof']
                        digest = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':'),
                                                           allow_nan=False).encode()).hexdigest()
                        if isinstance(proof, list):
                            proof = tuple(proof)
                        valid = (record['run'] == run and record['fence'] == fence and
                                 record['hash'] == proof_hash == digest and verifier is not None and
                                 verifier(run, fence, proof) is True)
                    final = os.stat(self.path.name, dir_fd=directory_fd, follow_symlinks=False)
                    return (valid and same_directory() and
                            (opened.st_dev, opened.st_ino) == (final.st_dev, final.st_ino))
                finally:
                    os.close(fd)
            finally:
                os.close(directory_fd)
        except (OSError, ValueError, KeyError, TypeError):
            return False


class AttestationIdentityTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='attestation-identity-evidence-'))
        self.directory = self.root / 'authority'
        self.directory.mkdir()
        self.attestation = FileAttestation(self.directory)
        self.attestation.publish_bootstrap()

    def replace_directory(self):
        self.directory.rename(self.root / 'original-authority')
        self.directory.mkdir()
        (self.directory / 'clean-attestation.json').write_text('{"bootstrap": true}')

    def test_directory_replaced_before_first_identity_check(self):
        real_open = os.open
        def replace_after_open(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            if Path(path) == self.directory:
                self.replace_directory()
            return fd
        with mock.patch('test_dirty_marker_testonly.os.open', side_effect=replace_after_open):
            self.assertFalse(self.attestation.verify('', '', '', None))
        self.assertTrue((self.root / 'original-authority' / 'clean-attestation.json').exists())

    def test_directory_or_file_replaced_during_verification(self):
        real_fsync = os.fsync
        def replace_during_fsync(fd):
            real_fsync(fd)
            if not replaced:
                replaced.append(True)
                if kind == 'directory':
                    self.replace_directory()
                else:
                    self.attestation.path.rename(self.root / 'original-attestation.json')
                    self.attestation.path.write_text('{"bootstrap": true}')
        for kind in ('directory', 'file'):
            with self.subTest(kind=kind):
                if kind == 'file':
                    self.directory = self.root / 'file-authority'
                    self.directory.mkdir()
                    self.attestation = FileAttestation(self.directory)
                    self.attestation.publish_bootstrap()
                replaced = []
                with mock.patch('test_dirty_marker_testonly.os.fsync', side_effect=replace_during_fsync):
                    self.assertFalse(self.attestation.verify('', '', '', None))
                self.assertTrue(replaced)
        self.assertTrue((self.root / 'original-attestation.json').exists())

    def test_directory_replaced_by_verifier_is_rejected(self):
        proof = 'proof'
        digest = hashlib.sha256(json.dumps(proof, separators=(',', ':')).encode()).hexdigest()
        self.attestation.publish('run', 'fence', proof, digest)
        def verifier(*args):
            self.replace_directory()
            return True
        self.assertFalse(self.attestation.verify('run', 'fence', digest, verifier))
        self.assertTrue((self.root / 'original-authority' / 'clean-attestation.json').exists())

    def test_rename_failure_preserves_old_and_temporary_records(self):
        with mock.patch('test_dirty_marker_testonly.os.replace', side_effect=OSError('rename failed')):
            with self.assertRaises(OSError):
                self.attestation.publish('run', 'fence', 'proof', 'hash')
        self.assertEqual(json.loads(self.attestation.path.read_text()), {'bootstrap': True})
        retained = list(self.directory.glob('attestation-*'))
        self.assertEqual(len(retained), 1)
        self.assertEqual(json.loads(retained[0].read_text())['run'], 'run')


class MarkerTest(unittest.TestCase):
    def setUp(self):
        # Keep private diagnostic files even when a test fails.
        self.tmp = tempfile.mkdtemp(prefix='marker-test-evidence-')
        root = Path(os.environ['TEST_PG_ROOT'])
        self.pg = IsolatedPostgres(bindir=str(root / 'bin'), share=str(root / 'share/pgsql'),
                                   library_path=str(root / 'lib64'), parent=self.tmp)
        self.pg.__enter__()
        self.attestation = FileAttestation(self.tmp)
        self.addCleanup(self.pg.close)

    def session(self, **kwargs):
        kwargs.setdefault('attestation', self.attestation)
        session = Experiment(self.pg, **kwargs)
        self.addCleanup(session.evidence.close)
        self.addCleanup(session.close)
        return session

    def test_bootstrap_and_clean_only_after_same_run_drain(self):
        a = self.session()
        a.bootstrap()
        run = a.start()
        with self.assertRaises(Rejected):
            a.finish(run, drain_confirmed=False)
        with self.assertRaises(Rejected):
            a.finish('00000000-0000-0000-0000-000000000000', drain_confirmed=True)
        fence = a.fence
        a.finish(run, drain_confirmed=True)
        with self.assertRaises(Rejected):
            a.reconcile(run, fence, 'proof')
        a.close()
        b = self.session(reconciliation_verifier=lambda r, f, p: (r, f, p) == (run, fence, 'proof'))
        with self.assertRaises(Rejected):
            b.start()
        with self.assertRaises(Rejected):
            b.reconcile(run, str(__import__('uuid').uuid4()), 'proof')
        b.reconcile(run, fence, 'proof')
        self.assertTrue(b.start())

    def test_dirty_recovery_requires_exact_independent_proof_and_pending(self):
        a = self.session()
        a.bootstrap()
        run = a.start()
        fence = a.fence
        a.close()
        b = self.session(reconciliation_verifier=lambda r, f, p: (r, f, p) == (run, fence, 'proof'))
        with self.assertRaises(Rejected):
            b.start()
        with self.assertRaises(Rejected):
            b.reconcile(run, fence, 'proof')
        with self.assertRaises(Rejected):
            b.authorize_dirty_reconciliation(run, fence, 'wrong')
        with self.assertRaises(Rejected):
            b.authorize_dirty_reconciliation(run, str(__import__('uuid').uuid4()), 'proof')
        self.assertEqual(b._query('SELECT state FROM dirty_marker_testonly'), ['dirty'])
        # Even a verifier that accepts a proof cannot override the database fence.
        b.verifier = lambda r, f, p: True
        with self.assertRaises(Rejected):
            b.authorize_dirty_reconciliation(run, str(__import__('uuid').uuid4()), 'proof')
        self.assertEqual(b._query('SELECT state FROM dirty_marker_testonly'), ['dirty'])
        b.verifier = lambda r, f, p: (r, f, p) == (run, fence, 'proof')
        b.authorize_dirty_reconciliation(run, fence, 'proof')
        self.assertEqual(b._query('SELECT state FROM dirty_marker_testonly'), ['pending'])
        with self.assertRaises(Rejected):
            b.start()
        b.reconcile(run, fence, 'proof')
        self.assertTrue(b.start())

    def test_missing_bootstrap_rejected(self):
        with self.assertRaises(Rejected):
            self.session().start()

    def test_crash_before_marker_commit_rolls_back(self):
        a = self.session()
        a.bootstrap()
        a._query("BEGIN; UPDATE dirty_marker_testonly SET state='dirty', "
                 "run_id='00000000-0000-0000-0000-000000000001'")
        a.close()
        self.assertTrue(self.session().start())

    def test_crash_after_commit_rejects_restart(self):
        a = self.session()
        a.bootstrap()
        a.start()
        a.close()
        with self.assertRaises(Rejected):
            self.session().start()

    def test_lost_reply_after_commit_rejects_restart(self):
        a = self.session()
        a.bootstrap()
        query = a._query
        def lost(sql):
            result = query(sql)
            if sql.startswith('UPDATE dirty_marker_testonly'):
                a.failed = True
                raise Rejected('simulated lost reply')
            return result
        with mock.patch.object(a, '_query', side_effect=lost):
            with self.assertRaises(Rejected):
                a.start()
        a.close()
        with self.assertRaises(Rejected):
            self.session().start()

    def test_lost_pending_reply_requires_reconciliation_after_restart(self):
        a = self.session()
        a.bootstrap()
        run = a.start()
        fence = a.fence
        query = a._query
        def lost(sql):
            result = query(sql)
            if "SET state='pending'" in sql:
                a.failed = True
                raise Rejected('simulated lost reply')
            return result
        with mock.patch.object(a, '_query', side_effect=lost):
            with self.assertRaises(Rejected):
                a.finish(run, drain_confirmed=True)
        a.close()
        b = self.session(reconciliation_verifier=lambda r, f, p: (r, f, p) == (run, fence, 'proof'))
        with self.assertRaises(Rejected):
            b.start()
        b.reconcile(run, fence, 'proof')
        self.assertTrue(b.start())

    def test_lost_clean_reply_requires_prior_independent_proof(self):
        a = self.session(reconciliation_verifier=lambda r, f, p: p == (r, f))
        a.bootstrap()
        run = a.start()
        fence = a.fence
        a.finish(run, drain_confirmed=True)
        query = a._query
        def lost(sql):
            result = query(sql)
            if "SET state='clean'" in sql:
                a.failed = True
                raise Rejected('simulated lost reply')
            return result
        with mock.patch.object(a, '_query', side_effect=lost):
            with self.assertRaises(Rejected):
                a.reconcile(run, fence, (run, fence))
        a.close()
        # A clean row without a separately published attestation is not authority.
        with self.assertRaises(Rejected):
            self.session().start()

    def test_attestation_publication_failures_and_exact_proof(self):
        verifier = lambda r, f, p: p == 'proof'
        a = self.session(reconciliation_verifier=verifier)
        a.bootstrap()
        run = a.start()
        fence = a.fence
        a.finish(run, drain_confirmed=True)
        with mock.patch.object(self.attestation, 'publish', side_effect=OSError('crash before publication')):
            with self.assertRaises(OSError):
                a.reconcile(run, fence, 'proof')
        a.close()
        b = self.session(reconciliation_verifier=verifier)
        with self.assertRaises(Rejected):
            b.start()
        b.close()
        # Recovery of a clean row without its matching attestation is unsupported.
        # A verifier that accepts every proof cannot make the stale record valid.
        c = self.session(reconciliation_verifier=lambda r, f, p: True)
        with self.assertRaises(Rejected):
            c.start()

    def test_attestation_fsync_failures_preserve_evidence_and_reject(self):
        a = self.session(reconciliation_verifier=lambda r, f, p: p == 'proof')
        a.bootstrap()
        run = a.start()
        fence = a.fence
        a.finish(run, drain_confirmed=True)
        real_fsync = os.fsync
        calls = []
        def fail_directory(fd):
            calls.append(fd)
            if len(calls) == 2:
                raise OSError('directory fsync failed')
            return real_fsync(fd)
        with mock.patch('test_dirty_marker_testonly.os.fsync', side_effect=fail_directory):
            with self.assertRaises(OSError):
                a.reconcile(run, fence, 'proof')
        a.close()
        self.assertEqual(json.loads(self.attestation.path.read_text())['run'], run)
        b = self.session(reconciliation_verifier=lambda r, f, p: p == 'proof')
        for failure in (1, 2):
            calls = []
            def fail_verify(fd):
                calls.append(fd)
                if len(calls) == failure:
                    raise OSError('verification fsync failed')
                return real_fsync(fd)
            with self.subTest(fsync=failure), mock.patch('test_dirty_marker_testonly.os.fsync', side_effect=fail_verify):
                with self.assertRaises(Rejected):
                    b.start()
            self.assertEqual(json.loads(self.attestation.path.read_text())['run'], run)
        # A fresh successful file and directory fsync establishes publication.
        self.assertTrue(b.start())

    def test_pre_rename_fsync_failure_keeps_temporary_evidence(self):
        self.attestation.publish_bootstrap()
        with mock.patch('test_dirty_marker_testonly.os.fsync', side_effect=OSError('file fsync failed')):
            with self.assertRaises(OSError):
                self.attestation.publish('run', 'fence', 'proof', 'hash')
        self.assertEqual(json.loads(self.attestation.path.read_text()), {'bootstrap': True})
        retained = list(Path(self.tmp).glob('attestation-*'))
        self.assertEqual(len(retained), 1)
        self.assertEqual(json.loads(retained[0].read_text())['run'], 'run')

    def test_constructor_failure_closes_but_retains_evidence(self):
        files = []
        create = tempfile.NamedTemporaryFile
        def record(**kwargs):
            evidence = create(**kwargs)
            files.append(evidence)
            return evidence
        with mock.patch.object(self.pg, '_probe'):
            with mock.patch('dirty_marker_testonly.tempfile.NamedTemporaryFile', side_effect=record):
                with mock.patch('dirty_marker_testonly.subprocess.Popen', side_effect=OSError('failure')):
                    with self.assertRaises(OSError):
                        Experiment(self.pg)
        evidence = files[0]
        self.assertTrue(evidence.closed)
        self.assertTrue(Path(evidence.name).is_file())
        self.assertEqual(os.stat(evidence.name).st_mode & 0o777, 0o600)

    def test_query_timeout_fails_closed(self):
        a = self.session(query_timeout=0.2)
        with self.assertRaises(Rejected):
            a._query('SELECT pg_sleep(2)')
        self.assertTrue(a.failed)

    def test_concurrent_start_and_lock_loss(self):
        a = self.session()
        a.bootstrap()
        run = a.start()
        with self.assertRaises(Rejected):
            self.session()
        self.assertEqual(a._query('SELECT pg_advisory_unlock(77112001)'), ['t'])
        with self.assertRaises(Rejected):
            a.finish(run, drain_confirmed=True)
        a.close()
        with self.assertRaises(Rejected):
            self.session().start()

    def test_connection_loss_never_cleans(self):
        a = self.session()
        a.bootstrap()
        run = a.start()
        a.proc.terminate()
        a.proc.wait(timeout=5)
        with self.assertRaises(Rejected):
            a.finish(run, drain_confirmed=True)
        with self.assertRaises(Rejected):
            self.session().start()


class PipeTest(unittest.TestCase):
    def make_session(self, code):
        a = Experiment.__new__(Experiment)
        a.cluster = mock.Mock()
        a.query_timeout = 0.2
        a.failed = False
        a._buffer = b''
        a._diagnostic_bytes = 0
        a._diagnostic_overflow = False
        a._stderr_eof = False
        a.evidence = tempfile.NamedTemporaryFile(mode='w+b', delete=False)
        a.evidence_path = a.evidence.name
        a.proc = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        for pipe in (a.proc.stdin, a.proc.stdout, a.proc.stderr):
            os.set_blocking(pipe.fileno(), False)
        self.addCleanup(a.evidence.close)
        def cleanup():
            try:
                a.close()
            except Rejected:
                if not a._diagnostic_overflow:
                    raise
        self.addCleanup(cleanup)
        return a

    def test_blocked_pipe_write_times_out(self):
        a = self.make_session('import time; time.sleep(10)')
        start = time.monotonic()
        with self.assertRaises(Rejected):
            a._query('x' * 1000000)
        self.assertLess(time.monotonic() - start, 2)
        self.assertTrue(a.failed)
        self.assertTrue(Path(a.evidence_path).exists())

    def test_diagnostic_overflow_fails_closed_and_retains_bounded_evidence(self):
        a = self.make_session("import os,time; os.write(2, b'x' * 100000); time.sleep(10)")
        a.query_timeout = 2
        with self.assertRaises(Rejected):
            a._query('SELECT 1')
        self.assertTrue(a._diagnostic_overflow)
        self.assertTrue(a.failed)
        with self.assertRaises(Rejected):
            a.close()
        self.assertEqual(os.path.getsize(a.evidence_path), 65536)

    def test_close_reports_new_overflow_after_resources_close(self):
        a = self.make_session('import os,time; os.write(2,b"x"*4096); time.sleep(10)')
        # Wait for real diagnostic bytes before close terminates the child.
        # A fixed sleep does not guarantee the child has run under load.
        readable, _, _ = select.select([a.proc.stderr], [], [], 5)
        self.assertTrue(readable, 'child did not write diagnostics before the deadline')
        a._diagnostic_bytes = 65536
        with self.assertRaisesRegex(Rejected, 'diagnostic output limit'):
            a.close()
        self.assertTrue(all(p.closed for p in (a.proc.stdin, a.proc.stdout, a.proc.stderr)))

    def test_cleanup_post_kill_wait_is_bounded(self):
        a = self.make_session('import time; time.sleep(10)')
        real_proc = a.proc
        fake = mock.Mock(wraps=real_proc)
        fake.stdin = real_proc.stdin
        fake.stdout = real_proc.stdout
        fake.stderr = real_proc.stderr
        fake.poll.return_value = None
        fake.wait.side_effect = [subprocess.TimeoutExpired('x', 5), subprocess.TimeoutExpired('x', 5)]
        fake.terminate = mock.Mock()
        fake.kill = mock.Mock()
        a.proc = fake
        with self.assertRaises(Rejected):
            a.close()
        self.assertEqual(fake.wait.call_args_list, [mock.call(timeout=5), mock.call(timeout=5)])
        self.assertTrue(a.failed)
        self.assertTrue(Path(a.evidence_path).exists())
        self.assertTrue(all(p.closed for p in (real_proc.stdin, real_proc.stdout, real_proc.stderr)))
        real_proc.kill()
        real_proc.wait(timeout=5)
        a.proc = real_proc

    def test_diagnostic_drain_checks_deadline(self):
        a = self.make_session("import sys,time; line=sys.stdin.readline(); "
                              "sentinel=sys.stdin.readline().split()[1]; "
                              "print(sentinel,flush=True); time.sleep(10)")
        # Simulate an always-readable diagnostic source after the reply.
        with mock.patch('dirty_marker_testonly.select.select', return_value=([a.proc.stderr], [], [])), \
             mock.patch.object(a, '_capture_diagnostics', side_effect=lambda: time.sleep(0.03)):
            with self.assertRaises(Rejected) as error:
                a._query('SELECT 1')
        self.assertIn('timeout', str(error.exception.__cause__))

    def test_stderr_eof_while_child_alive_does_not_spin(self):
        a = self.make_session("import os,time; os.close(2); time.sleep(10)")
        with self.assertRaises(Rejected):
            a._query('SELECT 1')
        self.assertTrue(a._stderr_eof)
        self.assertTrue(a.failed)

    def test_oversized_query_output_fails_closed(self):
        a = self.make_session("import os,time; os.write(1,b'x'*100000); time.sleep(10)")
        a.query_timeout = 2
        with self.assertRaises(Rejected) as error:
            a._query('SELECT 1')
        self.assertIn('output limit', str(error.exception.__cause__))
        self.assertTrue(a.failed)

    def test_evidence_budget_preserves_prior_files(self):
        with tempfile.TemporaryDirectory() as parent:
            pg = IsolatedPostgres.__new__(IsolatedPostgres)
            pg.closed = False
            pg.root = parent
            pg.parent = parent
            pg.check = mock.Mock()
            pg._probe = mock.Mock()
            prior = Path(parent) / 'marker-evidence-prior'
            prior.write_bytes(b'prior evidence')
            with mock.patch('dirty_marker_testonly.EVIDENCE_BUDGET', 65536):
                with self.assertRaisesRegex(Rejected, 'budget exhausted'):
                    Experiment(pg)
            self.assertEqual(prior.read_bytes(), b'prior evidence')
            self.assertEqual(len(list(Path(parent).glob('marker-evidence-*'))), 1)


if __name__ == '__main__':
    unittest.main()
