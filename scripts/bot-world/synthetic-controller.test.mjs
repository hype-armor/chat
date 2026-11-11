import test from 'node:test';
import assert from 'node:assert/strict';
import { BotController, initialState } from './controller.mjs';

const now = Date.UTC(2026, 5, 10, 12);
function setup({ limit = 12, singleBot = false, acceptSend = () => true } = {}) {
  let time = now; const members = [{ accountId: 'human', deviceId: 'hd' }, { accountId: 'bot-account', deviceId: 'bd' }, { accountId: 'bot-account-2', deviceId: 'bd2' }];
  if (singleBot) members.pop();
  const sent = [], saved = [], generated = [];
  const transport = { request: async (op, a) => { if (op === 'members') return { members, membershipKey: 'm1' }; sent.push(a); return { accepted: a.operationId.startsWith('disclosure-') || acceptSend() }; } };
  const world = { bots: [{ id: 'b', displayName: 'Bot', persona: {}, activity: { daysOfWeek: [3], activeHours: [0, 24] } }, { id: 'b2', displayName: 'Bot 2', persona: {}, activity: { daysOfWeek: [3], activeHours: [0, 24] } }], conversations: [] };
  const c = new BotController({ mode: 'synthetic', world, transport, provider: { generate: async (...args) => { generated.push(args); return 'local synthetic reply'; } }, store: { save: async (s) => saved.push(structuredClone(s)) }, state: initialState('x'), binding: 'x', now: () => time, random: () => 0, syntheticMessagesPerMinute: limit, syntheticBurstMin: 3, syntheticBurstMax: 3, syntheticReplyMinMs: 5000, syntheticReplyMaxMs: 30000, syntheticQuietMinMs: 300000, syntheticQuietMaxMs: 3600000, buildPrompt: () => { throw Error('prompt invoked'); } });
  c.state.accounts.b = { accountId: 'bot-account' }; c.state.accounts.b2 = { accountId: 'bot-account-2' }; c.connected.add('b'); c.connected.add('b2');
  let i = 0; const event = (text, event = 'message', extra = {}) => c.event({ eventId: `e${++i}`, event, conversationId: 'r', members, membershipKey: 'm1', senderAccountId: 'human', senderDeviceId: 'hd', messageId: `m${i}`, text, ...extra });
  return { c, event, sent, saved, generated, setTime: (v) => { time = v; } };
}
async function optIn(f) { await f.event('membership', 'membership'); await f.c.tick(); let r = f.c.state.rooms.r; assert.match(f.sent[0].text, /local random text.*No external inference requests/s); await f.event(`/bots consent ${r.nonce}`); return r; }

test('synthetic mode never stores or sends private human text to the generator', async () => {
  const f = setup(); const r = await optIn(f); await f.event('private message');
  assert.equal(JSON.stringify(r).includes('private message'), false); await f.c.tick();
  assert.deepEqual(f.generated[0][0], { signal: f.generated[0][0].signal });
  assert.equal(JSON.stringify(f.saved).includes('private message'), false); assert.deepEqual(r.history, []);
  assert.equal(r.syntheticLastBotId, 'b'); assert.equal(r.turns, 1);
});

test('synthetic gaps, quiet periods, and separate global minute cap are deterministic', async () => {
  const f = setup({ limit: 1 }); const r = await optIn(f); await f.event('trigger');
  await f.c.tick(); assert.equal(r.nextAt, now + 5000); assert.equal(f.c.state.syntheticQuota.used, 1);
  f.setTime(now + 5000); await f.c.tick(); assert.equal(f.c.state.syntheticQuota.used, 1);
  f.setTime(now + 60000); await f.c.tick(); assert.equal(f.c.state.syntheticQuota.used, 1); // one send per rolling minute
  f.setTime(now + 120000); await f.c.tick(); assert.equal(r.nextAt, now + 420000); assert.equal(r.history.length, 0);
  assert.equal(f.c.state.quota.used, 0);
  f.setTime(now + 420000); await f.c.tick();
  assert.equal(f.generated.length, 4); // A new burst after quiet, without another human trigger.
});

test('synthetic consent, stop/start, and membership changes require fresh consent', async () => {
  const f = setup(); const r = await optIn(f); const n = r.nonce;
  r.syntheticBurstLimit = 6;
  await f.event('/bots stop'); assert.equal(r.paused, true); assert.deepEqual(r.consent, []);
  assert.equal(r.syntheticBurstLimit, 0);
  await f.event('/bots start'); assert.equal(r.paused, false); assert.notEqual(r.nonce, n);
  await f.c.tick(); await f.event(`/bots consent ${r.nonce}`); assert.deepEqual(r.consent, ['human']);
  await f.event('membership', 'membership', { membershipKey: 'm2' }); assert.deepEqual(r.consent, []); assert.equal(r.syntheticTriggered, false);
});

test('AI remains the constructor default and modes validate', () => {
  const f = setup(); assert.equal(f.c.mode, 'synthetic');
  const ai = new BotController({ world: {}, transport: {}, provider: {}, store: {}, binding: 'x' });
  assert.equal(ai.mode, 'ai');
  assert.throws(() => new BotController({ mode: 'invalid', world: {}, transport: {}, provider: {}, store: {}, binding: 'x' }), /Invalid controller mode/);
  assert.throws(() => new BotController({ mode: 'synthetic', syntheticMessagesPerMinute: 121, world: {}, transport: {}, provider: {}, store: {}, binding: 'x' }), /Invalid controller mode/);
});

test('a single bot can answer another human turn without storing its content', async () => {
  const f = setup({ singleBot: true }); const r = await optIn(f);
  await f.event('first private input'); await f.c.tick();
  assert.equal(f.generated.length, 1);
  f.setTime(now + 5000); await f.event('second private input'); await f.c.tick();
  assert.equal(f.generated.length, 2);
  assert.deepEqual(r.history, []);
  assert.ok(!JSON.stringify(f.saved).includes('private input'));
});

test('pending retries share the current traffic budget and retain their operation ID', async () => {
  let accepted = false;
  const f = setup({ limit: 1, acceptSend: () => accepted }); const r = await optIn(f);
  await f.event('trigger'); await f.c.tick();
  const operationId = r.pendingSend.operationId;
  assert.equal(f.sent.length, 2); // Disclosure plus the first attempt.
  f.setTime(now - 1000); await f.c.tick();
  assert.equal(f.c.state.syntheticQuota.windowAt, now);
  assert.equal(f.c.state.syntheticQuota.used, 1);
  f.setTime(now + 5000); await f.c.tick(); assert.equal(f.sent.length, 2);
  f.setTime(now + 60000); accepted = true; await f.c.tick();
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].operationId, operationId);
  assert.equal(f.generated.length, 1);
  assert.equal(r.pendingSend, null);
  assert.equal(f.c.state.syntheticQuota.used, 1);
});

test('global spacing applies across rooms, not just each conversation', async () => {
  const f = setup(); const r = await optIn(f);
  await f.event('membership', 'membership', { conversationId: 'r2' });
  await f.c.tick(); const r2 = f.c.state.rooms.r2;
  await f.event(`/bots consent ${r2.nonce}`, 'message', { conversationId: 'r2' });
  await f.event('trigger'); await f.event('trigger', 'message', { conversationId: 'r2' });
  await f.c.tick(); assert.equal(f.generated.length, 1);
  f.setTime(now + 4999); await f.c.tick(); assert.equal(f.generated.length, 1);
  f.setTime(now + 5000); await f.c.tick(); assert.equal(f.generated.length, 2);
  assert.deepEqual(r.history, []);
});

test('stop intake cancels a local generation before send issuance', async () => {
  const f = setup(); const r = await optIn(f); await f.event('trigger');
  let started, release;
  const entered = new Promise((resolve) => { started = resolve; });
  f.c.provider.generate = ({ signal }) => { started(signal); return new Promise((resolve) => { release = resolve; }); };
  const running = f.c.tick(); const signal = await entered;
  await f.event('/bots stop'); assert.equal(signal.aborted, true);
  release('unused synthetic result'); await running;
  assert.equal(f.sent.length, 1);
  assert.equal(r.paused, true);
  assert.equal(r.pendingSend, null);
});

test('stop intake during an issued send does not advance burst cadence', async () => {
  const f = setup(); const r = await optIn(f); await f.event('trigger');
  let started, release;
  const entered = new Promise((resolve) => { started = resolve; });
  const request = f.c.transport.request;
  f.c.transport.request = async (op, payload) => {
    if (op === 'send') { started(); return new Promise((resolve) => { release = resolve; }); }
    return request(op, payload);
  };
  const running = f.c.tick(); await entered;
  const stopping = f.event('/bots stop');
  release({ accepted: true }); await Promise.all([running, stopping]);
  assert.equal(r.paused, true);
  assert.equal(r.pendingSend, null);
  assert.equal(r.turns, 0);
  assert.ok(f.saved.every((state) => state.rooms.r.turns === 0));
});

test('switching modes clears room work but preserves both budgets', async () => {
  const f = setup(); const r = await optIn(f); await f.event('trigger'); await f.c.tick();
  f.c.state.quota.used = 37;
  r.pendingSend = { botId: 'b', text: 'old synthetic reply', operationId: 'old-operation' };
  const restore = (mode, state) => new BotController({ mode, world: f.c.world, transport: f.c.transport, provider: f.c.provider, store: f.c.store, state: structuredClone(state), binding: 'x' });
  const ai = restore('ai', f.c.state);
  assert.equal(ai.state.rooms.r.pendingSend, null);
  assert.deepEqual(ai.state.rooms.r.consent, []);
  assert.equal(ai.state.quota.used, 37);
  const synthetic = restore('synthetic', ai.state);
  assert.equal(synthetic.state.quota.used, 37);
  assert.equal(synthetic.state.syntheticQuota.used, 1);
  assert.deepEqual(synthetic.state.rooms.r.history, []);
});
