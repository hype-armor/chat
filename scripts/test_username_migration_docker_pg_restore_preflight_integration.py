"""Non-destructive preflight against a supervised, isolated local cluster."""
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from username_migration_docker_pg_restore_testonly import TestOnlyPostgresRestore

BASE = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr')).parent
BIN = BASE / 'usr/bin'


@unittest.skipUnless((BIN / 'initdb').exists(), 'isolated PostgreSQL binaries unavailable')
class Integration(unittest.TestCase):
    def test_preflight(self):
        env = dict(os.environ, PATH=str(BIN) + os.pathsep + os.environ['PATH'],
                   LD_LIBRARY_PATH=str(BASE / 'usr/lib64'), PGCONNECT_TIMEOUT='2')
        env.pop('PGPASSWORD', None)
        with tempfile.TemporaryDirectory(prefix='pg-preflight-') as tmp:
            root = Path(tmp)
            data = root / 'data'
            archive_dir = root / 'archive'
            archive_dir.mkdir(mode=0o700)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = str(sock.getsockname()[1])
            def process(args, **kwargs):
                return subprocess.run(args, env=env, check=True, timeout=30,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
            process(['initdb', '-D', str(data), '-L', str(BASE / 'usr/share/pgsql'),
                     '-U', 'app', '--auth-local=trust', '--no-locale'])
            running = False
            try:
                process(['pg_ctl', '-D', str(data), '-l', str(root / 'log'), '-o',
                         f"-c listen_addresses='' -k {root} -p {port}", '-w', 'start'])
                running = True
                conn = ['-h', str(root), '-p', port, '-U', 'app']
                process(['createdb', *conn, 'appdb'])
                dump = process(['pg_dump', *conn, '-Fc', 'appdb']).stdout
                archive = archive_dir / 'postgres.dump'
                archive.write_bytes(dump)
                archive.chmod(0o600)
                identity = process(['psql', *conn, '-d', 'postgres', '-X', '-qAt', '-c',
                                    'SELECT system_identifier::text FROM pg_control_system()']).stdout.decode().strip()
                fd = os.open(archive_dir, os.O_RDONLY | os.O_DIRECTORY)
                calls = []
                try:
                    def runner(args, **kwargs):
                        calls.append(args)
                        command = args[args.index('exec') + 5:]
                        if command[0] == 'psql':
                            command = command[:1] + ['-h', str(root), '-p', port] + command[1:]
                        elif command != ['pg_restore', '--list']:
                            raise AssertionError('unexpected Docker command')
                        kwargs['env'] = env
                        return subprocess.run(command, **kwargs)
                    with patch('username_migration_docker_pg_restore_testonly._disk_directory'):
                        adapter = TestOnlyPostgresRestore(directory_fd=fd, source_system_identifier=identity,
                            operation='operation_123456', role='app', database='appdb',
                            archive_sha256=hashlib.sha256(dump).hexdigest(), container_id='a' * 64,
                            verify_rollback_fence=lambda *_: True)
                        adapter.preflight(runner=runner)
                    self.assertEqual(len(calls), 2)
                finally:
                    os.close(fd)
            finally:
                if running:
                    process(['pg_ctl', '-D', str(data), '-m', 'fast', '-w', 'stop'])


if __name__ == '__main__':
    unittest.main()
