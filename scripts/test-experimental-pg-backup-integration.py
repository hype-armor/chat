#!/usr/bin/env python3
"""Use two temporary local PostgreSQL clusters and a Docker command adapter."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(os.environ.get('TEST_PG_ROOT', '/tmp/chat-irc-pg-isolated-root/usr'))
binpath = root / 'bin'
env = dict(os.environ, LD_LIBRARY_PATH=str(root / 'lib64'))
script = Path(__file__).with_name('experimental-pg-backup-validate.sh')
with tempfile.TemporaryDirectory(prefix='backup-integration-') as tmp:
    base = Path(tmp)
    started = []
    try:
        for name in ('source', 'target'):
            data, sock = base / (name + '-data'), base / (name + '-sock')
            sock.mkdir()
            subprocess.run([str(binpath / 'initdb'), '-L', str(root / 'share/pgsql'), '-D', str(data), '-A', 'trust', '--no-locale', '-U', 'postgres'], env=env, check=True, capture_output=True)
            subprocess.run([str(binpath / 'pg_ctl'), '-D', str(data), '-l', str(base / (name + '.log')), '-o', f"-k {sock} -p 55441 -c listen_addresses=''", '-w', 'start'], env=env, check=True, capture_output=True)
            started.append(data)
        def sql(which, query):
            return subprocess.run([str(binpath / 'psql'), '-XAt', '-v', 'ON_ERROR_STOP=1', '-h', str(base / (which + '-sock')), '-p', '55441', '-U', 'postgres', '-d', 'postgres', '-c', query], env=env, check=True, capture_output=True, text=True).stdout.strip()
        sql('source', "CREATE TABLE sample (id integer PRIMARY KEY, value text); INSERT INTO sample VALUES (1, 'synthetic');")
        adapter = base / 'docker'
        adapter.write_text('''#!/usr/bin/env python3
import os, sys
a = sys.argv[1:]
base = os.environ['TEST_BASE']
binpath = os.environ['TEST_BIN']
if 'pg_dump' in a:
    cmd = ['pg_dump', '-h', base + '/source-sock', '-p', '55441', '-U', 'postgres', '-d', 'postgres', '-Fc']
elif 'pg_restore' in a:
    cmd = ['pg_restore', '-h', base + '/target-sock', '-p', '55441', '-U', 'postgres', '-d', 'postgres', '--exit-on-error', '--no-owner', '--no-privileges']
else:
    sys.exit(0)
os.execv(binpath + '/' + cmd[0], cmd)
''')
        adapter.chmod(0o700)
        backups = base / 'backups'
        backups.mkdir(mode=0o700)
        testenv = dict(env, PATH=str(base) + ':' + env['PATH'], TEST_BASE=str(base), TEST_BIN=str(binpath), PGUSER='postgres', PGDATABASE='postgres', PGPASSWORD='synthetic', VALIDATION_IMAGE='postgres@sha256:' + 'a' * 64)
        result = subprocess.run(['bash', str(script), 'synthetic', str(backups / 'archive')], env=testenv, capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        assert sql('target', 'SELECT id, value FROM sample') == '1|synthetic'
        assert 'NOT full recovery' in result.stderr
        print('PASS: isolated PostgreSQL data-only dump and restore')
    finally:
        for data in reversed(started):
            subprocess.run([str(binpath / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'], env=env, check=True, capture_output=True)
