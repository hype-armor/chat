import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { NativeTransport } from './transport.mjs';

async function worker(t, onEvent = () => {}) {
  const directory = await mkdtemp(join(process.cwd(), '.bot-ipc-test-'));
  const path = join(directory, 'worker.mjs');
  await writeFile(path, `#!${process.execPath}
import { createInterface } from 'node:readline';
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
  const command = JSON.parse(line);
  if (command.op === 'crash') { process.exit(1); return; }
  if (command.op === 'event') console.log(JSON.stringify({event:'connected',eventId:'test-event',botId:'bot-001'}));
  if (command.op === 'reject') console.log(JSON.stringify({id:command.id,ok:false,error:'secret must never appear'}));
  else console.log(JSON.stringify({id:command.id,ok:true,result:{botId:command.botId,hasProviderKey:!!process.env.CHAT_BOT_AI_API_KEY,hasStateKey:!!process.env.CHAT_BOT_STATE_KEY}}));
});
`);
  await chmod(path, 0o700);
  const transport = new NativeTransport(path, { env: { CHAT_BOT_AI_API_KEY: 'private-api-key', CHAT_BOT_STATE_KEY: 'test-state-key' }, onEvent });
  t.after(async () => {
    if (!transport.closed) { const exited = once(transport.child, 'exit'); transport.close(); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  return transport;
}

test('stdio bridge correlates replies and does not pass provider credentials to native worker', async (t) => {
  const transport = await worker(t);
  const results = await Promise.all([transport.request('echo', { botId: 'bot-001' }), transport.request('echo', { botId: 'bot-002' })]);
  assert.deepEqual(results.map((r) => r.botId), ['bot-001', 'bot-002']);
  assert.ok(results.every((r) => r.hasStateKey && !r.hasProviderKey));
  assert.equal(transport.pending.size, 0);
});

test('stdio bridge delivers events and exposes only safe operation errors', async (t) => {
  const events = [];
  const transport = await worker(t, (event) => events.push(event));
  await transport.request('event');
  assert.equal(events[0].eventId, 'test-event');
  await assert.rejects(transport.request('reject'), (error) => error.nativeOperation && !error.message.includes('secret'));
});

test('worker failure rejects pending requests instead of leaving hanging timers', async (t) => {
  const transport = await worker(t);
  await assert.rejects(transport.request('crash'), /transport stopped/);
  await assert.rejects(transport.request('echo'), /unavailable/);
  assert.equal(transport.pending.size, 0);
});
