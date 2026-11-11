import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./run.mjs', import.meta.url));
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', ...env } });
}

test('default CLI mode only plans the world without credentials or activation', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.activated, false);
  assert.equal(plan.bots, 100);
  assert.equal(plan.model, 'openrouter/free');
});

test('network modes require explicit activation before reading secrets or starting worker', () => {
  for (const mode of ['bootstrap', 'run']) {
    const result = run([mode], { CHAT_BOTS_ENABLED: 'false', CHAT_BOT_BINARY: '/must-not-run' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHAT_BOTS_ENABLED=true/);
  }
});

test('CLI rejects unsafe endpoints and unsupported modes without leaking credentials', () => {
  const invalid = run(['delete-everything']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?secret=value']) {
    const result = run(['run'], { CHAT_BOTS_ENABLED: 'true', CHAT_BOT_SERVER: url });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use HTTPS/);
    assert.ok(!result.stderr.includes('secret'));
  }
});
