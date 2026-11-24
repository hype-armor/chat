#!/usr/bin/env python3
"""Mock-only tests; no production Docker or PostgreSQL calls."""
import os
from pathlib import Path
import subprocess
import tempfile

script = Path(__file__).with_name('experimental-pg-backup-validate.sh')
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    bindir = root / 'bin'
    bindir.mkdir()
    backups = root / 'backups'
    backups.mkdir(mode=0o700)
    log = root / 'log'
    docker = bindir / 'docker'
    docker.write_text('''#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
if [[ "$*" == *pg_dump* ]]; then
  [[ ${FAIL_STAGE:-} != dump ]] || exit 1
  printf archive
  [[ ${FAIL_STAGE:-} != diskfull ]] || exit 1
elif [[ "$*" == *pg_restore* ]]; then
  [[ ${FAIL_STAGE:-} != restore ]] || exit 1
  [[ $(head -c 7) == archive ]] || exit 1
  if [[ ${FAIL_STAGE:-} == race ]]; then ln -s "$RACE_TARGET" "$RACE_PATH"; fi
elif [[ "$*" == 'run '* ]]; then
  [[ ${FAIL_STAGE:-} != run ]] || exit 1
elif [[ "$*" == 'rm '* ]]; then
  [[ ${FAIL_STAGE:-} != cleanup ]] || exit 1
fi
''')
    docker.chmod(0o755)
    (root / 'sitecustomize.py').write_text('''import os, stat\n_original = os.fsync\ndef injected(fd):\n    stage = os.environ.get("FAIL_STAGE")\n    if stage == "fsync" or (stage == "dirfsync" and stat.S_ISDIR(os.fstat(fd).st_mode)):\n        raise OSError("injected fsync failure")\n    return _original(fd)\nos.fsync = injected\n''')
    env = dict(os.environ, PATH=f'{bindir}:' + os.environ['PATH'], MOCK_LOG=str(log), PYTHONPATH=str(root),
               PGUSER='chat', PGDATABASE='chat', PGPASSWORD='test-only',
               VALIDATION_IMAGE='postgres@sha256:' + 'a' * 64)
    def run(name, stage='', **extra):
        log.write_text('')
        return subprocess.run(['bash', str(script), 'mock-postgres', str(backups / name)],
                              env=dict(env, FAIL_STAGE=stage, **extra), capture_output=True, text=True)
    assert run('good').returncode == 0
    assert (backups / 'good').stat().st_mode & 0o777 == 0o600
    calls = log.read_text()
    assert '--network none' in calls and '--pull=never' in calls and '--exit-on-error' in calls
    assert 'rm -f chat-restore-check-' in calls
    assert 'test-only' not in calls
    assert run('good').returncode != 0
    for stage in ('dump', 'diskfull', 'run', 'restore', 'cleanup', 'fsync'):
        result = run(stage, stage)
        assert result.returncode != 0, stage
        assert 'UNVERIFIED' in result.stderr
        assert not (backups / stage).exists(), stage
        calls = log.read_text()
        assert ('rm -f chat-restore-check-' in calls) == (stage in ('run', 'restore', 'cleanup'))
        if stage == 'cleanup':
            assert 'cleanup failed' in result.stderr
        assert 'test-only' not in result.stderr
    result = run('dirfsync', 'dirfsync')
    assert result.returncode != 0 and 'durability is uncertain' in result.stderr
    assert (backups / 'dirfsync').read_bytes() == b'archive'
    target = root / 'target'
    target.write_text('unchanged')
    result = run('race', 'race', RACE_TARGET=str(target), RACE_PATH=str(backups / 'race'))
    assert result.returncode != 0 and target.read_text() == 'unchanged'
    assert (backups / 'race').is_symlink()
    (backups / 'race').unlink()
    assert run('symlink', RACE_PATH='').returncode == 0
    (backups / 'symlink').unlink()
    (backups / 'symlink').symlink_to(target)
    assert run('symlink').returncode != 0 and target.read_text() == 'unchanged'
    assert run('bad-image', VALIDATION_IMAGE='postgres:18').returncode != 0
    assert not (backups / 'bad-image').exists()
    backups.chmod(0o755)
    assert run('bad-mode').returncode != 0
print('PASS: mock backup validation and failures')
