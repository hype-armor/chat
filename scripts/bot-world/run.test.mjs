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
  assert.equal(plan.generationMode, 'synthetic');
  assert.equal(plan.model, null);
  assert.equal(plan.messagesPerMinute, 12);
});

test('AI mode remains explicit, and synthetic mode needs no provider key', () => {
  const ai = run(['plan'], { CHAT_BOT_MODE: 'ai' });
  assert.equal(ai.status, 0, ai.stderr);
  assert.equal(JSON.parse(ai.stdout).model, 'openrouter/free');
  const synthetic = run(['run'], { CHAT_BOTS_ENABLED: 'true', CHAT_BOT_MODE: 'synthetic', CHAT_BOT_BINARY: '/must-not-run' });
  assert.equal(synthetic.status, 1);
  assert.match(synthetic.stderr, /CHAT_BOT_STATE_KEY/);
  assert.ok(!synthetic.stderr.includes('AI provider API key'));
});

test('invalid generation mode and synthetic traffic caps fail before activation', () => {
  for (const env of [{ CHAT_BOT_MODE: 'unknown' }, ...['0', '-1', '121', 'NaN', '1.5'].map((value) => ({ CHAT_BOT_MESSAGES_PER_MINUTE: value }))]) {
    const result = run(['plan'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bot generation mode|Synthetic message rate/);
  }
  const capped = run(['plan'], { CHAT_BOT_MESSAGES_PER_MINUTE: '30' });
  assert.equal(capped.status, 0, capped.stderr);
  assert.equal(JSON.parse(capped.stdout).messagesPerMinute, 30);
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
