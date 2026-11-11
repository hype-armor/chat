import test from 'node:test';
import assert from 'node:assert/strict';
import { BotController, initialState } from './controller.mjs';

const members = [{ accountId: 'bot-account', deviceId: 'bot-device' }, { accountId: 'human', deviceId: 'human-device' }];
function controller(state = initialState('membership-test')) {
  return new BotController({ world: { bots: [], conversations: [] }, state, binding: 'membership-test',
    store: { save: async () => {} }, provider: { disclosure: 'Test provider' },
    transport: { request: async () => ({ members, membershipKey: '1:old' }) },
  });
}

test('a delayed device cannot restore an older MLS membership or consent context', async () => {
  const c = controller();
  await c.event({ event: 'membership', eventId: 'current', conversationId: 'room', members, membershipKey: '2:current' });
  const room = c.state.rooms.room;
  room.consent = ['human']; room.history = [{ text: 'current permitted context' }];
  const nonce = room.nonce;
  await c.event({ event: 'message', eventId: 'stale', conversationId: 'room', members, membershipKey: '1:old',
    messageId: 'stale-message', senderAccountId: 'human', senderDeviceId: 'human-device', text: 'old epoch text' });
  assert.equal(room.membershipKey, '2:current');
  assert.equal(room.nonce, nonce);
  assert.deepEqual(room.history, [{ text: 'current permitted context' }]);
  assert.equal(await c.current(room, 'bot'), false);
  assert.equal(room.membershipKey, '2:current');
});

test('JSON restore rebuilds prototype-safe maps for peer-chosen group identifiers', async () => {
  const state = JSON.parse(JSON.stringify(initialState('membership-test')));
  const c = controller(state);
  for (const map of [c.state.rooms, c.state.accounts, c.state.fixtures]) assert.equal(Object.getPrototypeOf(map), null);
  await c.event({ event: 'membership', eventId: 'prototype-name', conversationId: 'toString', members, membershipKey: '1:room' });
  assert.equal(c.state.rooms.toString.id, 'toString');
  const restored = controller(JSON.parse(JSON.stringify(c.state)));
  assert.equal(restored.state.rooms.toString.id, 'toString');
  assert.equal(Object.getPrototypeOf(restored.state.rooms), null);
});

test('device-change notices clear room consent and cancel work on another managed member', async () => {
  const c = controller();
  c.state.accounts['bot-a'] = { accountId: 'bot-account' };
  await c.event({ event: 'membership', eventId: 'initial', conversationId: 'room', members, membershipKey: '2:current' });
  const room = c.state.rooms.room;
  room.consent = ['human']; room.history = [{ text: 'private permitted text' }];
  c.inflight = { roomId: 'room', botId: 'different-managed-bot', abort: new AbortController() };
  const abort = c.inflight.abort;
  await c.event({ event: 'disconnected', eventId: 'devices-changed', botId: 'bot-a', requiresConsentReset: true });
  assert.equal(abort.signal.aborted, true);
  assert.deepEqual(room.consent, []);
  assert.deepEqual(room.history, []);
  assert.equal(room.disclosed, false);
});
