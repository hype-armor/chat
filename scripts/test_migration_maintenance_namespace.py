#!/usr/bin/env python3
"""Opt-in Linux integration test for the disposable maintenance boundary.

Use only synthetic processes and sockets. Do not invoke Docker or the migration
entry point. The unshare parent is an independent controller in this test.
"""
import argparse
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve()


def abstract_address(port):
    return f'\0chat-maintenance-fence-test-{port}'


def worker(port):
    if os.getppid() != 1 or {name for _, name in socket.if_nameindex()} != {'lo'}:
        raise RuntimeError('private fixture required')
    # Detach from the controller's process group. A process-group kill alone
    # would not stop this writer.
    os.setsid()
    with socket.socket() as server:
        server.bind(('127.0.0.1', port))
        server.listen()
        while True:
            conn, _ = server.accept()
            with conn:
                conn.sendall(b'maintenance')


def fixture(port):
    if os.getpid() != 1:
        raise RuntimeError('private PID namespace required')
    if {name for _, name in socket.if_nameindex()} != {'lo'}:
        raise RuntimeError('private loopback-only network required')
    child = subprocess.Popen([sys.executable, str(SCRIPT), '--worker', str(port)])
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('worker exited')
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.2) as conn:
                    if conn.recv(64) == b'maintenance':
                        break
            except ConnectionRefusedError:
                time.sleep(0.02)
        else:
            raise RuntimeError('worker did not become ready')
        # The detached worker inherits stdout. EOF cannot occur while it lives.
        with socket.socket(socket.AF_UNIX) as local:
            local.bind(abstract_address(port))
            local.listen()
            print('ready', flush=True)
            signal.pause()
    finally:
        child.kill()
        child.wait()


class MaintenanceNamespaceTest(unittest.TestCase):
    run_disposable = False

    def test_loopback_private_and_controller_death_contains_detached_worker(self):
        if not self.run_disposable:
            self.skipTest('requires --run-disposable')
        disk = os.statvfs(tempfile.gettempdir())
        self.assertGreaterEqual(disk.f_bavail * disk.f_frsize, 800 * 1024**2)
        # Reserve a loopback port in this namespace. The inner writer must be
        # able to bind the exact same address without reaching this listener.
        with socket.socket() as outside:
            outside.bind(('127.0.0.1', 0))
            outside.listen()
            port = outside.getsockname()[1]
            command = ['/usr/bin/unshare', '--user', '--map-root-user', '--net', '--pid',
                       '--fork', '--kill-child=SIGKILL', '--', '/usr/bin/bash', '-ec',
                       '/usr/sbin/ip link set lo up; exec "$@"', 'namespace-test',
                       sys.executable, str(SCRIPT), '--fixture', str(port)]
            controller = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                          env={'PATH': '/usr/bin:/usr/sbin', 'LC_ALL': 'C',
                                               'PYTHONDONTWRITEBYTECODE': '1'})
            with controller:
                try:
                    ready, _, _ = select.select([controller.stdout], [], [], 8)
                    self.assertTrue(ready, 'maintenance boundary did not start')
                    line = controller.stdout.readline()
                    if not line:
                        _, err = controller.communicate(timeout=5)
                        self.fail(err.decode(errors='replace'))
                    self.assertEqual(line, b'ready\n')
                    with socket.socket(socket.AF_UNIX) as local:
                        local.settimeout(2)
                        with self.assertRaises(ConnectionRefusedError):
                            local.connect(abstract_address(port))
                    # A connection to the old address arrives at the observer,
                    # not at the maintenance writer which uses the same port.
                    with socket.create_connection(('127.0.0.1', port), 2) as client:
                        outside.settimeout(2)
                        accepted, _ = outside.accept()
                        with accepted:
                            accepted.sendall(b'outside')
                            self.assertEqual(client.recv(64), b'outside')
                finally:
                    if controller.poll() is None:
                        controller.kill()
                    stdout, stderr = controller.communicate(timeout=8)
                self.assertEqual(controller.returncode, -signal.SIGKILL)
                self.assertEqual(stdout, b'')
                self.assertEqual(stderr, b'')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-disposable', action='store_true')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--fixture', type=int, help=argparse.SUPPRESS)
    group.add_argument('--worker', type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fixture:
        fixture(args.fixture)
    elif args.worker:
        worker(args.worker)
    elif args.run_disposable:
        MaintenanceNamespaceTest.run_disposable = True
        unittest.main(argv=[sys.argv[0], '-v'])
    else:
        parser.error('pass --run-disposable to create private Linux namespaces')
