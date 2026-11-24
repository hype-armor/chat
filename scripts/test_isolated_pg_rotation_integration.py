#!/usr/bin/env python3
"""Exercise rotation SQL against a disposable PostgreSQL, not Docker or live data."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

base = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr')).parent
env = {**os.environ, 'PATH': str(base / 'usr/bin') + os.pathsep + os.environ['PATH'],
       'LD_LIBRARY_PATH': str(base / 'usr/lib64'), 'PGCONNECT_TIMEOUT': '2'}
env.pop('PGPASSWORD', None)
spec = importlib.util.spec_from_file_location('rotation', Path(__file__).with_name('isolated_pg_rotation.py'))
rotation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rotation)
image, cid, volume = 'sha256:' + 'a' * 64, 'b' * 64, 'synthetic_volume'
old, new = 'd' * 64, 'e' * 64
operation_id = 'f' * 32
name = 'chat-pg-fence-' + operation_id
exists = False

def process(args, *, input=None, password=None, check=True):
    e = dict(env)
    if password is not None:
        e['PGPASSWORD'] = password
    return subprocess.run(args, input=input, text=True, capture_output=True, env=e, check=check, timeout=30)

with tempfile.TemporaryDirectory(prefix='chat-pg-rotation-integration-') as tmp:
    root, running = Path(tmp), False
    data = root / 'data'
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = str(s.getsockname()[1])
    process(['initdb', '-D', str(data), '-L', str(base / 'usr/share/pgsql'), '-U', 'chat', '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale'])
    def start(listen):
        global running
        process(['pg_ctl', '-D', str(data), '-l', str(root / 'server.log'), '-o', f"-c listen_addresses='{listen}' -k {root} -p {port}", '-w', 'start'])
        running = True
    def stop():
        global running
        process(['pg_ctl', '-D', str(data), '-m', 'fast', '-w', 'stop'])
        running = False
    def local_sql(query):
        return process(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(root), '-p', port, '-U', 'chat', '-d', 'postgres'], input=query).stdout.strip()
    def tcp(password):
        return process(['psql', '-X', '-qAt', '-h', '127.0.0.1', '-p', port, '-U', 'chat', '-d', 'postgres'], input='SELECT 1;', password=password, check=False)
    def docker(args, *, input=None):
        global exists
        # This adapter models Docker commands but runs genuine local PostgreSQL.
        if args[1:3] == ['ps', '--filter']:
            return ''
        if args[1:3] == ['ps', '-a']:
            return name if exists else ''
        if args[1] in ('image', 'volume'):
            return ''
        if args[1] == 'create':
            exists = True
            return cid
        if args[1] == 'inspect':
            return json.dumps([{'Id': cid, 'Name': '/' + name, 'Config': {'Labels': {'chat.rotation.operation': operation_id}}, 'Image': image, 'HostConfig': {'NetworkMode': 'none'}, 'Mounts': [{'Type': 'volume', 'Name': volume, 'Destination': '/var/lib/postgresql'}]}])
        if args[1] == 'start':
            start('')
            return cid
        if args[1] == 'exec' and 'pg_isready' in args:
            return process(['pg_isready', '-h', str(root), '-p', port, '-U', 'chat', '-d', 'postgres']).stdout.strip()
        if args[1] == 'exec' and 'psql' in args:
            return local_sql(input)
        if args[1] == 'rm':
            exists = False
            if running:
                stop()
            return cid
        raise AssertionError('unexpected simulated Docker command')
    try:
        start('127.0.0.1')
        local_sql("ALTER ROLE chat PASSWORD '%s';" % old)
        assert tcp(old).returncode == 0
        stop()
        rotation.rotate_isolated(image, volume, 'chat', new, operation_id=operation_id, journal_path=str(root / 'journal'), run=docker, sleep=lambda _: None)
        assert not running
        start('127.0.0.1')
        assert tcp(old).returncode != 0
        assert tcp(new).returncode == 0
        print('PASS: adapter SQL rotated an isolated PostgreSQL role; old TCP credential failed after restart')
    finally:
        if running:
            stop()
