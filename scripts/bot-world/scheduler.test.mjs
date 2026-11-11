import test from 'node:test';
import assert from 'node:assert/strict';
import { BotController, initialState } from './controller.mjs';

test('the shared free budget serves every room size before a second new DM', async () => {
  let now = Date.parse('2026-11-11T12:00:00Z');
  const bots = Array.from({ length: 50 }, (_, i) => ({
    id: `bot-${String(i).padStart(2, '0')}`, displayName: `Fictional bot ${i} (AI bot)`, persona: {},
    activity: { daysOfWeek: [3], activeHours: [0, 24] },
  }));
  const sizes = [['a-direct', 2], ['b-direct', 2], ['z-trio', 3], ['z-ten', 10], ['z-fifty', 50]];
  const conversations = sizes.map(([id, size]) => ({
    id, memberIds: bots.slice(0, size).map((bot) => bot.id),
    participation: bots.slice(0, size).map((bot) => ({ botId: bot.id, replyWeight: 1 })),
  }));
  const world = { bots, conversations };
  const state = initialState('scheduler-test');
  for (const bot of bots) state.accounts[bot.id] = { accountId: bot.id, deviceId: `${bot.id}-device` };
  const memberships = Object.fromEntries(conversations.map((room) => [room.id, {
    members: room.memberIds.map((id) => ({ accountId: id, deviceId: `${id}-device` })), membershipKey: `1:${room.id}`,
  }]));
  const sends = [];
  const controller = new BotController({
    world, state, binding: 'scheduler-test', store: { save: async () => {} },
    provider: { generate: async () => 'A short fictional reply.' },
    transport: { request: async (op, payload) => {
      if (op === 'members') return memberships[payload.conversationId];
      if (op === 'send') { sends.push(payload.conversationId); return { accepted: true }; }
      throw new Error('Unexpected test operation.');
    } },
    buildPrompt: () => ({ system: 'Synthetic fixture.', messages: [] }), now: () => now, random: () => 0,
  });
  controller.connected = new Set(bots.map((bot) => bot.id));
  for (const room of conversations) {
    state.fixtures[room.id] = room.id;
    await controller.event({ event: 'membership', eventId: room.id, conversationId: room.id, ...memberships[room.id] });
  }
  for (let i = 0; i < 5; i++) { await controller.tick(); now += 6000; }
  const selectedSizes = sends.map((id) => memberships[id].members.length);
  assert.deepEqual(new Set(selectedSizes.slice(0, 4)), new Set([2, 3, 10, 50]));
  assert.equal(sends[4], 'b-direct');
  assert.equal(state.quota.used, 5);
});
