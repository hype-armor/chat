import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StateStore, stateKey } from './store.mjs';

const keyBytes = () => randomBytes(32);
async function tempDir(t) {
  const dir = await mkdtemp(join(process.cwd(), '.bot-state-test-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}
const mode = async (path) => (await stat(path)).mode & 0o777;

test('state key accepts only canonical base64 for 32 bytes', () => {
  const bytes = keyBytes();
  assert.deepEqual(stateKey(bytes.toString('base64')), bytes);
  assert.throws(() => stateKey('bad'), /canonical base64/);
  assert.throws(() => stateKey(Buffer.alloc(31).toString('base64')), /canonical base64/);
});

test('encrypted state round-trips atomically with private file modes and no plaintext', async (t) => {
  const dir = await tempDir(t); const key = keyBytes(); const store = new StateStore(dir, key);
  await store.lock();
  assert.equal(await mode(dir), 0o700);
  const state = { binding: 'config-id', room: { history: ['UNIQUE-PLAINTEXT-MARKER'], consent: ['human'] }, count: 3 };
  try {
    await store.save(state);
    const path = join(dir, 'controller.enc');
    assert.equal(await mode(path), 0o600);
    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from('UNIQUE-PLAINTEXT-MARKER')), false);
    assert.equal(bytes.includes(Buffer.from('config-id')), false);
    assert.deepEqual(await store.load(), state);
    assert.deepEqual((await readdir(dir)).sort(), ['controller.enc', 'controller.lock']);
    await store.save({ ...state, count: 4 });
    assert.deepEqual(await store.load(), { ...state, count: 4 });
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false);
  } finally { await store.close(); }
});

test('lock excludes a second writer until the first closes', async (t) => {
  const dir = await tempDir(t); const first = new StateStore(dir, keyBytes()); const second = new StateStore(dir, keyBytes());
  await first.lock();
  try { await assert.rejects(second.lock()); }
  finally { await first.close(); }
  await second.lock(); await second.close();
});

test('tampered ciphertext and wrong keys fail closed', async (t) => {
  const dir = await tempDir(t); const key = keyBytes(); const store = new StateStore(dir, key);
  await store.lock();
  try {
    await store.save({ privateValue: 'do not expose' });
    const path = join(dir, 'controller.enc'); const sealed = await readFile(path);
    sealed[sealed.length - 1] ^= 1; await writeFile(path, sealed);
    await assert.rejects(store.load(), /authentication failed/);
    await store.save({ privateValue: 'do not expose' });
    const wrongKey = new StateStore(dir, keyBytes());
    await assert.rejects(wrongKey.load(), /authentication failed/);
  } finally { await store.close(); }
});

test('flock releases a subprocess-owned state lock after its owner is killed', async (t) => {
  if (process.platform !== 'linux') { t.skip('This lock recovery check targets Linux flock.'); return; }
  assert.equal(spawnSync('flock', ['--version'], { encoding: 'utf8' }).status, 0, 'Linux flock binary is required.');
  const dir = await tempDir(t); const key = keyBytes();
  const moduleUrl = new URL('./store.mjs', import.meta.url).href;
  const source = `const { StateStore } = await import(${JSON.stringify(moduleUrl)}); const store = new StateStore(process.argv[1], Buffer.from(process.argv[2], 'base64')); await store.lock(); process.stdout.write('READY\\n'); process.stdin.resume();`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source, dir, key.toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill('SIGKILL');
      await once(owner, 'exit');
    }
  });
  let output = '';
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error(`Lock owner readiness timed out: ${output}`)), 5000);
    owner.stdout.on('data', (chunk) => { output += chunk; if (output.includes('READY\n')) { clearTimeout(readyTimer); resolve(); } });
    owner.stderr.on('data', (chunk) => { output += chunk; });
    owner.once('error', (error) => { clearTimeout(readyTimer); reject(error); });
    owner.once('exit', (code) => { if (!output.includes('READY\n')) { clearTimeout(readyTimer); reject(new Error(`Lock owner exited before ready (${code}): ${output}`)); } });
  });
  await ready;
  const exited = once(owner, 'exit');
  owner.kill('SIGKILL');
  await exited;

  const deadline = Date.now() + 3000;
  let recovered = false; let lastError;
  while (Date.now() < deadline) {
    const contender = new StateStore(dir, key);
    try { await contender.lock(); await contender.close(); recovered = true; break; }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.equal(recovered, true, `Fresh lock was not available after owner death: ${lastError}`);
});

test('store refuses save before lock and rejects an unsafe directory mode', async (t) => {
  const dir = await tempDir(t); const store = new StateStore(dir, keyBytes());
  await assert.rejects(store.save({}), /not locked/);
  // The temp directory is private by default. Widen it to verify fail-closed behavior.
  const { chmod } = await import('node:fs/promises');
  await chmod(dir, 0o755);
  await assert.rejects(store.lock(), /mode 0700/);
});
