#!/usr/bin/env python3
"""Test cache selection and installed shims without builds or network access."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
KEYS = ['CARGO_TARGET_DIR', 'npm_config_store_dir', 'PLAYWRIGHT_BROWSERS_PATH']
PROBE = 'import json,os; print(json.dumps({k:os.environ.get(k) for k in ' + repr(KEYS) + '}))'
with tempfile.TemporaryDirectory() as temporary:
    home = Path(temporary)
    env = {k: v for k, v in os.environ.items() if k not in KEYS}
    env.update(HOME=str(home), XDG_CACHE_HOME=str(home / 'cache'))
    def run(*args, extra=None):
        return subprocess.check_output(args, cwd=ROOT, env={**env, **(extra or {})}, text=True)
    shared = json.loads(run('bash', str(ROOT / 'scripts/chat-dev'), 'python3', '-c', PROBE))
    assert shared['CARGO_TARGET_DIR'] == str(home / 'cache/chat-dev/target')
    override = json.loads(run('bash', str(ROOT / 'scripts/chat-dev'), 'python3', '-c', PROBE,
                              extra={'CARGO_TARGET_DIR': '/tmp/explicit-target'}))
    assert override['CARGO_TARGET_DIR'] == '/tmp/explicit-target'
    isolated = json.loads(run('bash', str(ROOT / 'scripts/chat-dev'), '--isolated', 'python3', '-c', PROBE))
    assert isolated['CARGO_TARGET_DIR'] == str(ROOT / 'target/chat-dev-isolated/target')
    run('bash', str(ROOT / 'scripts/setup-dev-caches.sh'))
    run('bash', str(ROOT / 'scripts/setup-dev-caches.sh'))
    fake = home / 'fake'
    fake.mkdir()
    cargo = fake / 'cargo'
    cargo.write_text('#!/bin/sh\nexec python3 -c ' + __import__('shlex').quote(PROBE) + '\n')
    cargo.chmod(0o755)
    path = str(home / '.local/share/chat-dev/bin') + ':' + str(fake) + ':' + env['PATH']
    result = json.loads(run('cargo', extra={'PATH': path}))
    assert result == shared
    result = json.loads(run('cargo', extra={'PATH': path, 'CHAT_DEV_CACHE_MODE': 'isolated'}))
    assert result['CARGO_TARGET_DIR'] is None
print('PASS: shared defaults, explicit override, isolation, idempotent setup, automatic Cargo shim, bypass')
