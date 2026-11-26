#!/usr/bin/env python3
"""Exercise update.sh with fake Docker and Git; never contact live services."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile

script = (Path(__file__).resolve().parents[1] / 'update.sh').read_text()
with tempfile.TemporaryDirectory(prefix='chat-update-test-') as tmp:
    root = Path(tmp)
    for directory in ('scripts', 'bin', 'state'):
        (root / directory).mkdir()
    (root / 'update.sh').write_text(script)
    (root / 'README.md').write_text('fixture')
    (root / '.env').write_text('CHAT_VAPID_PRIVATE_KEY=synthetic\nCOMPOSE_PROFILES=echo\n')
    build = root / 'scripts/compose-build.sh'
    build.write_text('#!/bin/sh\n[ "$*" = "server web" ] || exit 1\necho BUILD >> "$LOG"\n[ "${FAIL_BUILD:-0}" != 1 ]\n')
    build.chmod(0o755)
    git = root / 'bin/git'
    git.write_text('''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args[:2] == ['rev-parse', '--git-path']: print('state')
elif args[:2] == ['ls-files', '-z']: sys.stdout.buffer.write(b'README.md\\0')
elif args[:2] == ['pull', '--ff-only']:
 with open(os.environ['LOG'], 'a') as f: f.write('PULL\\n')
else: raise SystemExit('unexpected git ' + str(args))
''')
    git.chmod(0o755)
    docker = root / 'bin/docker'
    docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['LOG'], 'a') as f: f.write('DOCKER ' + json.dumps(args) + '\\n')
assert os.environ.get('COMPOSE_PROFILES') == '', 'inherited Compose profile'
if 'config' in args:
 print(json.dumps({'name': 'chat', 'services': {s: {'build': {'context': '.'}, 'image': 'chat-' + s} for s in ['server', 'web']}}))
elif 'ps' in args:
 print('server\\nweb\\n' + ('https' if os.environ.get('HTTPS') == '1' else ''))
elif args[:2] == ['image', 'inspect']: print('synthetic-image')
''')
    docker.chmod(0o755)
    sudo = root / 'bin/sudo'
    sudo.write_text('#!/bin/sh\nexec "$@"\n')
    sudo.chmod(0o755)
    log = root / 'commands.log'
    env = {**os.environ, 'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH'], 'LOG': str(log), 'COMPOSE_PROFILES': 'echo'}
    for https in ('0', '1'):
        log.write_text('')
        result = subprocess.run(['bash', str(root / 'update.sh'), '--force'], env={**env, 'HTTPS': https}, text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, (result.stdout, result.stderr)
        lines = log.read_text().splitlines()
        commands = [(i, json.loads(line[7:])) for i, line in enumerate(lines) if line.startswith('DOCKER ')]
        down = [(i, args) for i, args in commands if 'down' in args]
        up = [(i, args) for i, args in commands if 'up' in args]
        assert len(down) == len(up) == 1 and lines.index('BUILD') < down[0][0] < up[0][0], lines
        assert '-v' not in down[0][1] and '--volumes' not in down[0][1]
        assert '--no-deps' not in up[0][1] and '--no-build' in up[0][1]
        assert '--env-file' in down[0][1] and '--env-file' in up[0][1]
        assert ('https' in up[0][1]) == (https == '1'), up
        assert [i for i, args in commands if any('echo' in arg for arg in args)] == [down[0][0]], commands
    log.write_text('')
    result = subprocess.run(['bash', str(root / 'update.sh'), '--force'], env={**env, 'FAIL_BUILD': '1'}, text=True, capture_output=True, timeout=15)
    assert result.returncode != 0
    assert not any('"down"' in line for line in log.read_text().splitlines())
    log.write_text('')
    result = subprocess.run(['bash', str(root / 'update.sh'), '--force', '--build-only'], env=env, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert 'BUILD' in log.read_text().splitlines()
    assert not any('"down"' in line or '"up"' in line for line in log.read_text().splitlines())
    # A supervisor keeps the same lock across the build and deployment phases.
    log.write_text('')
    with (root / 'state/lock').open('w') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        inherited = {**env, 'CHAT_UPDATE_LOCK_FD': str(lock.fileno())}
        result = subprocess.run(['bash', str(root / 'update.sh'), '--force', '--build-only'], env=inherited, pass_fds=(lock.fileno(),), text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, (result.stdout, result.stderr)
        assert 'BUILD' in log.read_text().splitlines()
        # A different descriptor cannot bypass the update lock.
        with (root / 'other-lock').open('w') as other:
            invalid = {**env, 'CHAT_UPDATE_LOCK_FD': str(other.fileno())}
            result = subprocess.run(['bash', str(root / 'update.sh'), '--build-only'], env=invalid, pass_fds=(other.fileno(),), text=True, capture_output=True, timeout=15)
            assert result.returncode != 0
    # Any marker blocks each separate invocation, including build-only and an
    # inherited lock. The updater must not modify the marker or call Git/Docker.
    marker = root / 'state/maintenance-in-progress'
    marker.write_text('in progress\n')
    for args in ([], ['--force'], ['--build-only']):
        log.write_text('')
        result = subprocess.run(['bash', str(root / 'update.sh'), *args], env=env, text=True, capture_output=True, timeout=15)
        assert result.returncode != 0 and 'Maintenance marker' in result.stderr, (result.stdout, result.stderr)
        assert log.read_text() == '' and marker.read_text() == 'in progress\n'
    with (root / 'state/lock').open('w') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        inherited = {**env, 'CHAT_UPDATE_LOCK_FD': str(lock.fileno())}
        result = subprocess.run(['bash', str(root / 'update.sh'), '--build-only'], env=inherited, pass_fds=(lock.fileno(),), text=True, capture_output=True, timeout=15)
        assert result.returncode != 0 and log.read_text() == ''
    marker.unlink()
    marker.symlink_to(root / 'missing-target')
    result = subprocess.run(['bash', str(root / 'update.sh')], env=env, text=True, capture_output=True, timeout=15)
    assert result.returncode != 0 and log.read_text() == '' and marker.is_symlink()
    marker.unlink()
    marker.mkdir()
    result = subprocess.run(['bash', str(root / 'update.sh')], env=env, text=True, capture_output=True, timeout=15)
    assert result.returncode != 0 and log.read_text() == '' and marker.is_dir()
    marker.rmdir()
    log.write_text('')
    result = subprocess.run(['bash', str(root / 'update.sh'), '--dry-run'], env=env, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert not any('"down"' in line or '"up"' in line for line in log.read_text().splitlines())
print('PASS: build-before-down, echo excluded from build/start, HTTPS preservation, volume safety, failed build, build-only, inherited lock, durable maintenance gate, dry run')
