"""Disposable fake-client tests for probe output and deadlines."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from isolated_pg_supervisor import EndpointError, IsolatedPostgres


class ProbeLimitsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='probe-test-')
        self.addCleanup(self.temp.cleanup)
        self.cluster = IsolatedPostgres(bindir=self.temp.name, share=self.temp.name,
                                        parent=self.temp.name)
        self.cluster.root = self.temp.name
        self.client = Path(self.temp.name) / 'psql'

    def script(self, body):
        self.client.write_text('#!' + sys.executable + '\nimport os, time\n' + body + '\n')
        self.client.chmod(0o700)

    def test_valid_and_exact_limit(self):
        token = self.cluster.token.encode('ascii')
        self.script(f'os.write(1, {token!r} + b" " * {4096 - len(token)})\nos.write(2, b"e" * 4096)')
        self.cluster._probe()

    def test_each_stream_over_limit_fails_closed(self):
        for fd, name in ((1, 'stdout'), (2, 'stderr')):
            with self.subTest(stream=name):
                self.script(f'os.write({fd}, b"x" * 4097)\ntime.sleep(30)')
                started = time.monotonic()
                with self.assertRaisesRegex(EndpointError, name + ' exceeds'):
                    self.cluster._probe()
                self.assertLess(time.monotonic() - started, 4)

    def test_nonzero_exit_preserves_bounded_diagnostics(self):
        self.script('os.write(1, b"out")\nos.write(2, b"error")\nraise SystemExit(7)')
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.cluster._probe()
        self.assertEqual((caught.exception.returncode, caught.exception.output,
                          caught.exception.stderr), (7, b'out', b'error'))

    def test_bad_identifier_fails(self):
        self.script('os.write(1, b"\\xff")')
        with self.assertRaisesRegex(EndpointError, 'identifier mismatch'):
            self.cluster._probe()

    def test_deadline_even_when_pipes_close_before_exit(self):
        self.script('os.close(1)\nos.close(2)\ntime.sleep(30)')
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.cluster._probe()
        self.assertLess(time.monotonic() - started, 8)


if __name__ == '__main__':
    unittest.main()
