import test from 'node:test';
import assert from 'node:assert/strict';
import { BotController, initialState } from './controller.mjs';

const NOW = Date.UTC(2026, 5, 10, 12);
function fixture({ humans = ['h1'], providerFn, store, state, disclosure = 'Test provider', now = NOW } = {}) {
  const members = [...humans.map((accountId, i) => ({ accountId, deviceId: `d-${accountId}` })), { accountId: 'ba', deviceId: 'bot-device' }];
  const calls = [];
  const transport = { request: async (op, args) => {
    calls.push({ op, ...args });
    if (op === 'members') return { members, membershipKey: 'm1' };
    return { accepted: true };
  } };
  const world = { bots: [{ id: 'bot-1', displayName: 'Bot One (AI bot)', persona: {}, activity: { daysOfWeek: [3], activeHours: [0, 24] } }], conversations: [{ id: 'fixture-room', memberIds: ['bot-1'], participation: [{ botId: 'bot-1', replyWeight: 1 }] }] };
  const provider = { disclosure, generate: providerFn ?? (async () => 'generated reply') };
  const saves = [];
  const backing = store ?? { save: async (s) => saves.push(structuredClone(s)) };
  const controller = new BotController({ world, transport, provider, store: backing, state: state ?? initialState('binding'), binding: 'binding', now: () => now, random: () => 0 });
  controller.state.accounts['bot-1'] = { accountId: 'ba' };
  controller.state.fixtures.fixture = 'fixture-room';
  controller.connected.add('bot-1');
  let seq = 0;
  const emit = (event, extra = {}) => controller.event({ eventId: `e${++seq}`, event, conversationId: 'room', members, membershipKey: 'm1', ...extra });
  const message = (senderAccountId, text, overrides = {}) => emit('message', { senderAccountId, senderDeviceId: `d-${senderAccountId}`, text, messageId: `msg-${seq + 1}`, ...overrides });
  async function startConsent() {
    await emit('membership');
    await controller.tick();
    const room = controller.state.rooms.room;
    return room;
  }
  return { controller, calls, saves, members, emit, message, startConsent, get now() { return now; } };
}

async function consentAll(f) {
  const room = await f.startConsent();
  for (const member of room.members) if (member.accountId.startsWith('h')) await f.message(member.accountId, `/ai consent ${room.nonce}`);
  return room;
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setImmediate(r)); } throw new Error('Timed out waiting for race setup.'); }

test('requires authenticated unanimous per-room consent and retains no pre-consent text', async () => {
  const f = fixture({ humans: ['h1', 'h2'] });
  await f.emit('membership');
  await f.message('h1', 'private before consent');
  await f.controller.tick();
  const room = f.controller.state.rooms.room;
  assert.deepEqual(room.history, []);
  assert.equal(room.disclosed, true);
  await f.message('h1', `/ai consent ${room.nonce}`);
  await f.message('h1', 'still not unanimous');
  assert.deepEqual(room.history, []);
  await f.message('h2', `/ai consent ${room.nonce}`);
  await f.message('outsider', `/ai consent ${room.nonce}`, { senderDeviceId: 'foreign' });
  await f.message('h1', 'after consent');
  assert.equal(room.history.length, 1);
  assert.equal(room.history[0].text, 'after consent');
  assert.deepEqual(room.consent.sort(), ['h1', 'h2']);
});

test('rejects nonmember and old-nonce consent', async () => {
  const f = fixture(); const room = await f.startConsent();
  const old = room.nonce;
  await f.message('intruder', `/ai consent ${old}`);
  await f.message('h1', `/ai consent stale-${old}`);
  assert.deepEqual(room.consent, []);
  await f.message('h1', `/ai consent ${old}`);
  assert.deepEqual(room.consent, ['h1']);
});

test('membership change clears consent and history and aborts pending inference', async () => {
  let resolve; let signal;
  const f = fixture({ providerFn: ({ signal: s }) => { signal = s; return new Promise((r) => { resolve = r; }); } });
  let room = await consentAll(f); await f.message('h1', 'private permitted');
  f.controller.state.quota.day = '2026-06-10';
  f.controller.state.rooms.room.lastAt = NOW - 180000;
  const ticking = f.controller.tick();
  while (!resolve) await new Promise((r) => setImmediate(r));
  await f.emit('membership', { membershipKey: 'm2', members: [...f.members, { accountId: 'h2', deviceId: 'd-h2' }] });
  assert.equal(signal.aborted, true);
  resolve('late output'); await ticking;
  room = f.controller.state.rooms.room;
  assert.deepEqual(room.history, []); assert.deepEqual(room.consent, []); assert.equal(room.pendingSend, null);
});

async function intakeRace(stage, revocation) {
  let providerCalls = 0;
  const f = fixture({ providerFn: async () => { providerCalls++; return 'must not send'; } });
  await consentAll(f); await f.message('h1', 'consented text');
  f.controller.state.rooms.room.lastAt = NOW - 180000;
  const original = f.controller.transport.request;
  const gate = deferred(); const entered = deferred(); let memberCalls = 0;
  const target = stage === 'before-provider' ? 1 : 2;
  f.controller.transport.request = async (op, args) => {
    if (op === 'members' && ++memberCalls === target) { entered.resolve(); return gate.promise; }
    return original(op, args);
  };
  const sendCount = () => f.calls.filter((call) => call.op === 'send' && call.text === 'must not send').length;
  const ticking = f.controller.tick();
  await entered.promise;
  let handling;
  if (revocation === 'stop') handling = f.message('h1', '/ai stop');
  else handling = f.emit('membership', { membershipKey: 'm2', members: [...f.members, { accountId: 'h2', deviceId: 'd-h2' }] });
  // event() calls observe() before it waits on the controller persistence queue.
  await until(() => (f.controller.observed.get('room') ?? 0) > 0);
  gate.resolve({ members: f.members, membershipKey: 'm1' });
  await Promise.all([ticking, handling]);
  assert.equal(providerCalls, stage === 'before-provider' ? 0 : 1, `${stage}/${revocation}: unexpected inference`);
  assert.equal(sendCount(), 0, `${stage}/${revocation}: sent output after revocation`);
  assert.equal(f.controller.state.rooms.room.pendingSend, null);
}

test('IPC stop and membership intake cancel while the pre-provider membership check waits', async () => {
  await intakeRace('before-provider', 'stop');
  await intakeRace('before-provider', 'membership');
});

test('IPC stop and membership intake cancel while the pre-send membership check waits', async () => {
  await intakeRace('before-send', 'stop');
  await intakeRace('before-send', 'membership');
});

test('/ai stop pauses and clears state; /ai start creates fresh consent', async () => {
  const f = fixture(); const room = await consentAll(f);
  const nonce = room.nonce; await f.message('h1', 'context');
  await f.message('h1', '/ai stop');
  assert.equal(room.paused, true); assert.deepEqual(room.history, []); assert.deepEqual(room.consent, []);
  await f.message('h1', '/ai start');
  assert.equal(room.paused, false); assert.notEqual(room.nonce, nonce); assert.deepEqual(room.consent, []);
});

test('bot-only fixtures can generate autonomously, with quota saved before provider call', async () => {
  let persistedUsed = 0;
  const backing = { save: async (s) => { persistedUsed = s.quota.used; } };
  const f = fixture({ humans: [], store: backing, providerFn: async () => { assert.equal(persistedUsed, 1); return 'hello'; } });
  f.controller.state.rooms['fixture-room'] = { id: 'fixture-room', members: f.members, membershipKey: 'm1', revision: 0, paused: false, lastAt: NOW - 180000, history: [], consent: [], nonce: 'n', disclosed: true, disclosureVersion: f.controller.disclosureVersion, turns: 0, recentMessages: [] };
  await f.controller.tick();
  assert.equal(f.controller.state.quota.used, 1);
  assert.equal(f.controller.state.rooms['fixture-room'].history.at(-1).text, 'hello');
});

test('inactive bots do not generate', async () => {
  let calls = 0;
  const f = fixture({ providerFn: async () => { calls++; return 'unexpected'; } });
  await consentAll(f); await f.message('h1', 'hello');
  f.controller.world.bots[0].activity.activeHours = [13, 14];
  f.controller.state.rooms.room.lastAt = NOW - 180000;
  await f.controller.tick();
  assert.equal(calls, 0);
});

test('provider failure persists quota and exponential backoff; next tick does not retry early', async () => {
  let calls = 0; let now = NOW;
  const f = fixture({ now, providerFn: async () => { calls++; throw new Error('offline'); } });
  await consentAll(f); await f.message('h1', 'hello'); f.controller.state.rooms.room.lastAt = NOW - 180000;
  await f.controller.tick();
  assert.equal(calls, 1); assert.equal(f.controller.state.quota.used, 1);
  assert.ok(f.controller.state.quota.blockedUntil > NOW);
  now = f.controller.state.quota.blockedUntil - 1;
  await f.controller.tick(); assert.equal(calls, 1);
});

test('pending send retries use the same operationId', async () => {
  const f = fixture(); await consentAll(f); await f.message('h1', 'hello');
  f.controller.state.rooms.room.lastAt = NOW - 180000;
  const original = f.controller.transport.request;
  let failSend = true;
  f.controller.transport.request = async (op, args) => {
    if (op === 'send' && failSend && args.text === 'generated reply') { failSend = false; f.calls.push({ op, ...args }); throw new Error('uncertain send'); }
    return original(op, args);
  };
  await assert.rejects(f.controller.tick(), /uncertain send/);
  const pendingId = f.controller.state.rooms.room.pendingSend.operationId;
  await f.controller.tick();
  const sends = f.calls.filter((c) => c.op === 'send' && c.text === 'generated reply');
  assert.equal(sends.length, 2); assert.equal(sends[0].operationId, pendingId); assert.equal(sends[1].operationId, pendingId);
});

test('restart recovers a pending send with its original operationId', async () => {
  const f = fixture(); await consentAll(f);
  const room = f.controller.state.rooms.room;
  room.pendingSend = { botId: 'bot-1', text: 'recovered reply', operationId: 'stable-op-1' };
  const restarted = new BotController({ world: f.controller.world, transport: f.controller.transport, provider: f.controller.provider, store: { save: async () => {} }, state: f.controller.state, binding: 'binding', now: () => NOW });
  restarted.connected.add('bot-1');
  await restarted.tick();
  const send = f.calls.find((call) => call.op === 'send' && call.text === 'recovered reply');
  assert.equal(send.operationId, 'stable-op-1');
  assert.equal(restarted.state.rooms.room.pendingSend, null);
});

test('disclosure is not complete until the server accepts it', async () => {
  const f = fixture(); await f.emit('membership');
  const original = f.controller.transport.request; let accepted = false;
  f.controller.transport.request = async (op, args) => {
    if (op === 'send') {
      f.calls.push({ op, ...args });
      return accepted ? { accepted: true } : { accepted: false, pending: true };
    }
    return original(op, args);
  };
  await f.controller.tick();
  const room = f.controller.state.rooms.room;
  assert.equal(room.disclosed, false);
  const first = f.calls.find((call) => call.op === 'send');
  assert.ok(first.text.startsWith('AI bots are participants'));
  accepted = true;
  await f.controller.tick();
  assert.equal(room.disclosed, true);
  const disclosures = f.calls.filter((call) => call.op === 'send' && call.text.startsWith('AI bots are participants'));
  assert.equal(disclosures.length, 2);
  assert.equal(disclosures[0].operationId, disclosures[1].operationId);
});

test('generated pending send stays persisted until accepted and restart reuses its operationId', async () => {
  let providerCalls = 0;
  const f = fixture({ providerFn: async () => { providerCalls++; return 'generated reply'; } });
  await consentAll(f); await f.message('h1', 'hello');
  f.controller.state.rooms.room.lastAt = NOW - 180000;
  const original = f.controller.transport.request; let accepted = false;
  f.controller.transport.request = async (op, args) => {
    if (op === 'send' && args.text === 'generated reply') {
      f.calls.push({ op, ...args });
      return accepted ? { accepted: true } : { accepted: false, pending: true };
    }
    return original(op, args);
  };
  await f.controller.tick();
  const room = f.controller.state.rooms.room;
  const operationId = room.pendingSend.operationId;
  assert.deepEqual(room.pendingSend, { botId: 'bot-1', text: 'generated reply', operationId });
  assert.equal(room.history.some((item) => item.text === 'generated reply'), false);
  assert.ok(f.saves.some((saved) => saved.rooms.room.pendingSend?.operationId === operationId));

  accepted = true;
  const restarted = new BotController({ world: f.controller.world, transport: f.controller.transport, provider: f.controller.provider, store: { save: async () => {} }, state: f.controller.state, binding: 'binding', now: () => NOW });
  restarted.connected.add('bot-1');
  await restarted.tick();
  assert.equal(providerCalls, 1);
  assert.equal(restarted.state.rooms.room.pendingSend, null);
  assert.equal(restarted.state.rooms.room.history.at(-1).text, 'generated reply');
  const sends = f.calls.filter((call) => call.op === 'send' && call.text === 'generated reply');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].operationId, operationId);
  assert.equal(sends[1].operationId, operationId);
});

test('provider disclosure change clears prior consent and history', async () => {
  const f = fixture(); const room = await consentAll(f); await f.message('h1', 'secret');
  const changed = new BotController({ world: f.controller.world, transport: f.controller.transport, provider: { disclosure: 'Changed provider', generate: async () => '' }, store: { save: async () => {} }, state: f.controller.state, binding: 'binding' });
  assert.deepEqual(changed.state.rooms.room.consent, []); assert.deepEqual(changed.state.rooms.room.history, []);
});

test('room history stays scoped and state binding is enforced', async () => {
  const f = fixture(); const a = await f.startConsent(); await f.message('h1', `/ai consent ${a.nonce}`); await f.message('h1', 'room A');
  await f.emit('membership', { conversationId: 'other', members: f.members, membershipKey: 'm1' });
  assert.equal(f.controller.state.rooms.room.history[0].text, 'room A');
  assert.deepEqual(f.controller.state.rooms.other.history, []);
  assert.throws(() => new BotController({ world: f.controller.world, transport: f.controller.transport, provider: { disclosure: 'x' }, store: {}, state: initialState('wrong'), binding: 'binding' }), /another configuration/);
});
