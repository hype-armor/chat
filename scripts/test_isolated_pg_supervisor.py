"""Integration tests: disposable PostgreSQL binaries from the isolated test root."""
import io
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

from isolated_pg_supervisor import EndpointError, IsolatedPostgres, _StartupNotReady

ROOT = str(Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr')).parent)


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.parent = tempfile.TemporaryDirectory(prefix='pg-supervisor-test-')
        self.addCleanup(self.parent.cleanup)

    def cluster(self):
        return IsolatedPostgres(bindir=ROOT + '/usr/bin', share=ROOT + '/usr/share/pgsql',
                                library_path=ROOT + '/usr/lib64', parent=self.parent.name)

    def test_initdb_diagnostic_limit(self):
        cluster = self.cluster()
        cluster.data = self.parent.name + '/data'
        script = Path(self.parent.name) / 'initdb'
        script.write_text('#!/bin/sh\nhead -c 100000 /dev/zero >&2\n')
        script.chmod(0o700)
        cluster.bindir = self.parent.name
        cluster.env['PATH'] = '/usr/bin:/bin'
        with self.assertRaisesRegex(EndpointError, 'initdb diagnostics'):
            cluster._initdb()

    def test_post_kill_wait_bounded_preserves_directory(self):
        cluster = self.cluster()
        cluster.root = self.parent.name
        cluster.root_id = None
        cluster.process = mock.Mock()
        cluster.process.poll.return_value = None
        cluster.process.wait.side_effect = [subprocess.TimeoutExpired('postgres', 10),
                                            subprocess.TimeoutExpired('postgres', 5)]
        with self.assertRaisesRegex(EndpointError, 'cleanup refused'):
            cluster.close()
        self.assertEqual(cluster.process.wait.call_args_list,
                         [mock.call(timeout=10), mock.call(timeout=5)])
        self.assertTrue(os.path.isdir(self.parent.name))

    def test_separate_clusters_and_cleanup(self):
        with self.cluster() as a, self.cluster() as b:
            self.assertNotEqual(a.token, b.token)
            self.assertNotEqual(a.socket_id, b.socket_id)
            a.run('createdb', ['-w', 'isolated_test'])
            result = b.run('psql', ['-X', '-qAt', '-c', "select count(*) from pg_database where datname='isolated_test'"], capture_output=True)
            self.assertEqual(result.stdout.strip(), b'0')
            paths = [a.root, b.root]
            children = [a.process, b.process]
        for path, child in zip(paths, children):
            self.assertFalse(os.path.exists(path))
            self.assertIsNotNone(child.poll())

    def test_replaced_socket_rejected(self):
        with self.cluster() as a:
            os.rename(a.socket, a.socket + '.old')
            with socket.socket(socket.AF_UNIX) as replacement:
                replacement.bind(a.socket)
                with self.assertRaises(EndpointError):
                    a.run('psql', ['-c', 'select 1'])

    def test_replacement_during_command_fails_postcheck(self):
        with self.cluster() as a:
            def replace():
                time.sleep(0.3)
                os.rename(a.socket, a.socket + '.old')
                with socket.socket(socket.AF_UNIX) as replacement:
                    replacement.bind(a.socket)
            worker = threading.Thread(target=replace)
            worker.start()
            try:
                with self.assertRaises(EndpointError):
                    a.run('psql', ['-X', '-c', 'select pg_sleep(1)'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            finally:
                worker.join()

    def test_stale_pid_rejected(self):
        with self.cluster() as a:
            pidfile = os.path.join(a.data, 'postmaster.pid')
            with open(pidfile, encoding='ascii') as f:
                original = f.read()
            try:
                with open(pidfile, 'w', encoding='ascii') as f:
                    f.write('1\n' + original.split('\n', 1)[1])
                with self.assertRaises(EndpointError):
                    a.run('psql', ['-c', 'select 1'])
            finally:
                with open(pidfile, 'w', encoding='ascii') as f:
                    f.write(original)

    def test_interrupted_command_rechecks_and_cleanup(self):
        with self.cluster() as a:
            with self.assertRaises(subprocess.TimeoutExpired):
                a.run('psql', ['-X', '-c', 'select pg_sleep(10)'], timeout=0.2,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            a.run('psql', ['-X', '-qAt', '-c', 'select 1'], stdout=subprocess.DEVNULL)
            path, child = a.root, a.process
        self.assertFalse(os.path.exists(path))
        self.assertIsNotNone(child.poll())

    def test_startup_pidfile_states_fail_closed(self):
        with self.cluster() as a:
            pidfile = os.path.join(a.data, 'postmaster.pid')
            with open(pidfile, encoding='ascii') as f:
                lines = f.read().splitlines()
            def check_with(content, startup):
                with mock.patch('builtins.open', return_value=io.StringIO(content)):
                    a.check(_startup=startup)
            prefix = '\n'.join(lines[:4])
            incomplete = [prefix, prefix + '\n', prefix + '\n\n',
                          prefix + '\n\n' + '\n'.join(lines[5:]) + '\n']
            for content in incomplete:
                with self.subTest(content=content):
                    with self.assertRaises(_StartupNotReady):
                        check_with(content, True)
                    with self.assertRaises(EndpointError) as error:
                        check_with(content, False)
                    self.assertIs(type(error.exception), EndpointError)
                    for index in (0, 1, 3):
                        wrong = content.split('\n')
                        wrong[index] = 'incorrect'
                        with self.assertRaises(EndpointError) as error:
                            check_with('\n'.join(wrong), True)
                        self.assertIs(type(error.exception), EndpointError)
            for index in (0, 1, 3, 4):
                wrong = lines.copy()
                wrong[index] = 'incorrect'
                with self.subTest(field=index), self.assertRaises(EndpointError) as error:
                    check_with('\n'.join(wrong) + '\n', True)
                self.assertIs(type(error.exception), EndpointError)
            with self.assertRaises(EndpointError) as error:
                check_with('\n'.join(lines[:3]), True)
            self.assertIs(type(error.exception), EndpointError)

    def test_startup_retries_only_not_ready(self):
        original = IsolatedPostgres.check
        calls = []
        def check(cluster, *, _startup=False):
            calls.append(_startup)
            if len(calls) == 1:
                raise _StartupNotReady('simulated initial pidfile')
            return original(cluster, _startup=_startup)
        with mock.patch.object(IsolatedPostgres, 'check', check):
            with self.cluster():
                self.assertGreaterEqual(len(calls), 2)
                self.assertTrue(all(calls))

    def test_socket_replacement_during_startup_retry_rejected(self):
        original = IsolatedPostgres.check
        calls = []
        with socket.socket(socket.AF_UNIX) as replacement:
            def check(cluster, *, _startup=False):
                calls.append(_startup)
                if len(calls) == 1:
                    os.rename(cluster.socket, cluster.socket + '.old')
                    replacement.bind(cluster.socket)
                    raise _StartupNotReady('simulated initial pidfile')
                return original(cluster, _startup=_startup)
            with mock.patch.object(IsolatedPostgres, 'check', check):
                with self.assertRaisesRegex(EndpointError, 'socket replaced'):
                    with self.cluster():
                        self.fail('replacement must not be accepted')
            self.assertEqual(calls, [True, True])

    def test_dead_child_rejected(self):
        with self.cluster() as a:
            a.process.terminate()
            a.process.wait(timeout=10)
            with self.assertRaises(EndpointError):
                a.run('psql', ['-c', 'select 1'])


if __name__ == '__main__':
    unittest.main()
