import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_SEED,
  generateWorld,
  getConversationContext,
  summarizeWorld,
  validateWorld,
} from './world.mjs';

const clone = (value) => structuredClone(value);
const pairKey = (members) => [...members].sort().join(':');

test('generates 100 unique, clearly labelled synthetic bots', () => {
  const world = generateWorld();
  assert.equal(world.bots.length, 100);
  assert.equal(new Set(world.bots.map(({ id }) => id)).size, 100);
  assert.equal(new Set(world.bots.map(({ displayName }) => displayName)).size, 100);
  for (const bot of world.bots) {
    assert.match(bot.id, /^bot-\d{3}$/);
    assert.equal(bot.synthetic, true);
    assert.match(bot.displayName, /\(AI bot\)$/);
  }
  assert.equal(world.seed, DEFAULT_SEED);
  assert.equal(validateWorld(world), world);
});

test('has exact conversation sizes, overlapping large groups, and sparse connected relationships', () => {
  const world = generateWorld();
  assert.deepEqual(summarizeWorld(world).conversationsBySize, { 2: 190, 3: 40, 10: 10, 50: 3 });
  for (const size of [2, 3, 10, 50]) {
    assert.ok(world.conversations.some(({ memberIds }) => memberIds.length === size));
  }
  const large = world.conversations.filter(({ memberIds }) => memberIds.length === 50);
  assert.equal(large.length, 3);
  assert.equal(large[0].memberIds.filter((id) => large[1].memberIds.includes(id)).length, 25);
  assert.equal(large[1].memberIds.filter((id) => large[2].memberIds.includes(id)).length, 25);
  assert.equal(new Set(large.flatMap(({ memberIds }) => memberIds)).size, 100);
  assert.equal(large[0].memberIds.some((id) => large[2].memberIds.includes(id)), false);

  const adjacency = new Map(world.bots.map(({ id }) => [id, new Set()]));
  const pairs = new Set();
  for (const relation of world.relationships) {
    const [a, b] = relation.memberIds;
    assert.notEqual(a, b);
    const key = pairKey(relation.memberIds);
    assert.ok(!pairs.has(key), `duplicate relationship ${key}`);
    pairs.add(key);
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  assert.ok(world.relationships.length < 100 * 15 / 2, 'graph must remain sparse');
  assert.ok([...adjacency.values()].every((neighbors) => neighbors.size >= 2 && neighbors.size <= 15));
  const reached = new Set([world.bots[0].id]);
  const pending = [world.bots[0].id];
  while (pending.length) {
    for (const peer of adjacency.get(pending.pop())) {
      if (!reached.has(peer)) { reached.add(peer); pending.push(peer); }
    }
  }
  assert.equal(reached.size, 100);
});

test('contains friends-of-friends who are not directly connected', () => {
  const world = generateWorld();
  const adjacency = new Map(world.bots.map(({ id }) => [id, new Set()]));
  for (const { memberIds: [a, b] } of world.relationships) {
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  let example;
  for (const [a, neighbors] of adjacency) {
    for (const b of neighbors) {
      for (const c of adjacency.get(b)) {
        if (a !== c && !neighbors.has(c)) { example = [a, b, c]; break; }
      }
      if (example) break;
    }
    if (example) break;
  }
  assert.ok(example, 'expected a two-hop pair without a direct relationship');
  const [a, , c] = example;
  assert.equal(adjacency.get(a).has(c), false);
  assert.equal(world.relationships.some(({ memberIds }) => pairKey(memberIds) === pairKey([a, c])), false);
});

test('uses deterministic seeded output and changes output for a changed seed', () => {
  assert.deepEqual(generateWorld(12345), generateWorld(12345));
  assert.notDeepEqual(generateWorld(12345), generateWorld(12346));
  assert.throws(() => generateWorld(-1), /Seed must be/);
  assert.throws(() => generateWorld(0x100000000), /Seed must be/);
});

test('checked-in fixture matches default generation byte for byte', async () => {
  const fixture = await readFile(new URL('../../fixtures/bot-world/default.json', import.meta.url), 'utf8');
  assert.equal(fixture, `${JSON.stringify(generateWorld(), null, 2)}\n`);
  assert.doesNotThrow(() => validateWorld(JSON.parse(fixture)));
});

test('validates graph invariants across multiple seeds', () => {
  for (const seed of [0, 0xffffffff, ...Array.from({ length: 32 }, (_, i) => i)]) {
    assert.doesNotThrow(() => validateWorld(generateWorld(seed)), `seed ${seed}`);
  }
});

test('survives a JSON round-trip and validates the restored configuration', () => {
  const world = generateWorld();
  const restored = JSON.parse(JSON.stringify(world));
  assert.deepEqual(restored, world);
  assert.equal(validateWorld(restored), restored);
});

test('projects only the requesting bot and data scoped to its conversation', () => {
  const world = generateWorld();
  const conversation = world.conversations.find(({ memberIds }) => memberIds.length === 3);
  const botId = conversation.memberIds[0];
  const context = getConversationContext(world, botId, conversation.id);
  assert.equal(context.self.id, botId);
  assert.deepEqual(context.conversation, conversation);
  assert.deepEqual(context.members.map(({ id }) => new Set(conversation.memberIds).has(id)), [true, true, true]);
  assert.ok(context.members.every((member) => Object.keys(member).sort().join(',') === 'displayName,id'));
  assert.ok(context.relationships.every(({ memberIds }) => memberIds.includes(botId)
    && memberIds.every((id) => conversation.memberIds.includes(id))));
  assert.deepEqual(context.backstories, world.backstories.filter(({ conversationId }) => conversationId === conversation.id));
  assert.equal(context.backstories.length, 1);
  assert.ok(!Object.hasOwn(context, 'personas'));
  assert.ok(!Object.hasOwn(context, 'privateBackstories'));
  assert.ok(context.members.every((member) => !Object.hasOwn(member, 'persona')));

  const direct = world.conversations.find(({ kind, memberIds }) => kind === 'direct'
    && memberIds.includes(botId) && memberIds.some((id) => id !== botId));
  const directContext = getConversationContext(world, botId, direct.id);
  assert.equal(directContext.backstories.length, 1);
  assert.ok(directContext.backstories.every(({ conversationId }) => conversationId === direct.id));
});

test('rejects nonmembers and isolates returned context from world data', () => {
  const world = generateWorld();
  const conversation = world.conversations.find(({ memberIds }) => memberIds.length === 2);
  const outsider = world.bots.find(({ id }) => !conversation.memberIds.includes(id));
  assert.throws(() => getConversationContext(world, outsider.id, conversation.id), /Not a conversation member/);
  assert.throws(() => getConversationContext(world, 'missing-bot', conversation.id), /Not a conversation member/);
  assert.throws(() => getConversationContext(world, conversation.memberIds[0], 'missing-conversation'), /Not a conversation member/);

  const context = getConversationContext(world, conversation.memberIds[0], conversation.id);
  context.self.persona.interests[0] = 'changed';
  context.conversation.memberIds.pop();
  context.members[0].displayName = 'changed';
  context.relationships.length = 0;
  context.backstories[0].text = 'changed';
  assert.notEqual(world.bots.find(({ id }) => id === conversation.memberIds[0]).persona.interests[0], 'changed');
  assert.equal(world.conversations.find(({ id }) => id === conversation.id).memberIds.length, 2);
  assert.notEqual(world.backstories.find(({ conversationId }) => conversationId === conversation.id).text, 'changed');
});

test('validator rejects malformed memberships and unsafe policies', () => {
  const cases = [
    ['community size', (w) => { w.communities[0].memberIds.pop(); }],
    ['unknown community member', (w) => { w.communities[0].memberIds[0] = 'bot-999'; }],
    ['conversation duplicate member', (w) => { w.conversations[0].memberIds[1] = w.conversations[0].memberIds[0]; }],
    ['unknown relationship member', (w) => { w.relationships[0].memberIds[0] = 'unknown'; }],
    ['wrong conversation kind', (w) => { w.conversations[0].kind = 'group'; }],
    ['missing large room', (w) => { w.conversations = w.conversations.filter((c) => c.id !== 'community-chat-3');
      w.backstories = w.backstories.filter((s) => s.conversationId !== 'community-chat-3'); }],
    ['unsafe history policy', (w) => { w.knowledgePolicy.historyScope = 'all-conversations'; }],
    ['group friendship policy', (w) => { w.knowledgePolicy.groupMembershipCreatesFriendship = true; }],
    ['friend-of-friend policy', (w) => { w.knowledgePolicy.friendOfFriendGrantsHistoryAccess = true; }],
    ['live registration policy', (w) => { w.knowledgePolicy.liveRegistrationEnabled = true; }],
  ];
  for (const [label, mutate] of cases) {
    const invalid = clone(generateWorld());
    mutate(invalid);
    assert.throws(() => validateWorld(invalid), Error, label);
  }
});

test('CLI generates JSON in a temporary directory and refuses to overwrite it', async (t) => {
  const dir = await mkdtemp(join(process.cwd(), '.bot-world-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'nested', 'world.json');
  const cli = new URL('./generate.mjs', import.meta.url).pathname;
  const first = spawnSync(process.execPath, [cli, '2468', output], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /"bots": 100/);
  const content = await readFile(output, 'utf8');
  const parsed = JSON.parse(content);
  assert.equal(parsed.seed, 2468);
  assert.equal(validateWorld(parsed), parsed);

  const second = spawnSync(process.execPath, [cli, '1357', output], { encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists|EEXIST/i);
  assert.equal(await readFile(output, 'utf8'), content);
});

test('CLI rejects malformed arguments without creating output', async (t) => {
  const dir = await mkdtemp(join(process.cwd(), '.bot-world-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'world.json');
  const cli = new URL('./generate.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'not-a-seed', output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(output, 'preserve me');
  const invalidSeed = spawnSync(process.execPath, [cli, '4294967296', output], { encoding: 'utf8' });
  assert.notEqual(invalidSeed.status, 0);
  assert.equal(await readFile(output, 'utf8'), 'preserve me');
});
