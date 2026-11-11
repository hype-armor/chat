// Synthetic configuration only. No accounts, credentials, network I/O, or message history.
export const DEFAULT_SEED = 20261111;
const circles = [
  ['Trail friends', 'hiking', 'They met through a fictional weekend walking club.'],
  ['Kitchen table', 'cooking', 'They trade recipes at a fictional community kitchen.'],
  ['Night readers', 'books', 'They attend a fictional monthly book circle.'],
  ['Side projects', 'making things', 'They met at a fictional neighbourhood repair workshop.'],
  ['Garden gate', 'gardening', 'They share a fictional community garden.'],
  ['Game night', 'board games', 'They meet at a fictional board-game cafe.'],
  ['Small stages', 'music', 'They volunteer at a fictional local music night.'],
  ['Photo walks', 'photography', 'They joined a fictional street-photography club.'],
  ['Park laps', 'running', 'They met through a fictional beginner running group.'],
  ['Art corner', 'drawing', 'They attend a fictional open sketch session.'],
];
const firstNames = ['Alex', 'Blair', 'Casey', 'Devon', 'Eden', 'Frankie', 'Harper', 'Indigo', 'Jules', 'Kai'];
const lastNames = ['Alder', 'Brook', 'Cedar', 'Dale', 'Elm', 'Field', 'Grove', 'Hill', 'Lake', 'Vale'];
const temperaments = ['warm and curious', 'dryly funny', 'thoughtful and reserved', 'practical and kind', 'enthusiastic but considerate'];
const styles = ['brief sentences', 'relaxed conversational prose', 'careful questions', 'occasional gentle humour', 'concrete examples'];
const roles = ['organizer', 'regular', 'listener', 'occasional contributor', 'connector'];
const pairKey = (a, b) => [a, b].sort().join(':');
const idFor = (n) => `bot-${String(n + 1).padStart(3, '0')}`;

function randomFor(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function generateWorld(seed = DEFAULT_SEED) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('Seed must be an unsigned 32-bit integer.');
  }
  const random = randomFor(seed);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const bots = Array.from({ length: 100 }, (_, n) => {
    const community = Math.floor(n / 10);
    const startHour = 7 + Math.floor(random() * 12);
    return {
      id: idFor(n),
      synthetic: true,
      displayName: `${firstNames[n % 10]} ${lastNames[community]} (AI bot)`,
      communityId: `circle-${community + 1}`,
      persona: {
        temperament: pick(temperaments),
        writingStyle: pick(styles),
        interests: [circles[community][1], circles[(community + 1 + Math.floor(random() * 9)) % 10][1]],
        personalDetail: `Fictional hobby project ${n + 1}: exploring a new aspect of ${circles[community][1]}.`,
      },
      activity: {
        timeZone: 'Etc/UTC',
        activeHours: [startHour, startHour + 4],
        daysOfWeek: n % 3 === 0 ? [1, 3, 5, 6] : [0, 1, 2, 3, 4, 5, 6],
        sociability: pick(['quiet', 'balanced', 'outgoing']),
      },
    };
  });
  const communities = circles.map(([name, interest], c) => ({
    id: `circle-${c + 1}`, name, interest,
    memberIds: bots.slice(c * 10, c * 10 + 10).map((b) => b.id),
  }));
  const relationships = [];
  const seenPairs = new Set();
  function relate(a, b, kind, origin) {
    const key = pairKey(a, b);
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    relationships.push({ id: `relationship-${relationships.length + 1}`, memberIds: [a, b].sort(), kind, origin });
  }
  for (let c = 0; c < 10; c++) {
    for (let i = 0; i < 10; i++) {
      relate(idFor(c * 10 + i), idFor(c * 10 + (i + 1) % 10), 'close-friend', 'Shared small-circle activities.');
      if (i % 2 === 0) relate(idFor(c * 10 + i), idFor(c * 10 + (i + 3) % 10), 'friend', 'Introduced by a mutual friend.');
    }
    // Two independent links join each circle to the next. The graph is not a clique.
    relate(idFor(c * 10), idFor(((c + 1) % 10) * 10 + 1), 'friend', 'Met while helping at a fictional community event.');
    relate(idFor(c * 10 + 5), idFor(((c + 1) % 10) * 10 + 6), 'acquaintance', 'Introduced through neighbouring interest circles.');
  }
  // Seeded long-range acquaintances make a few shortcuts between distant circles.
  for (let i = 0; i < 20; i++) {
    const a = Math.floor(random() * 100);
    const offset = 2 + Math.floor(random() * 7);
    const b = ((Math.floor(a / 10) + offset) % 10) * 10 + Math.floor(random() * 10);
    relate(idFor(a), idFor(b), 'acquaintance', 'Met at a fictional cross-community workshop.');
  }
  const conversations = [];
  const backstories = [];
  function conversation(id, name, memberIds, story) {
    conversations.push({
      id, name, kind: memberIds.length === 2 ? 'direct' : 'group', memberIds,
      participation: memberIds.map((botId, i) => ({
        botId, role: roles[i % roles.length],
        replyWeight: i % 5 === 2 ? 0.1 : i % 5 === 3 ? 0.25 : 0.6,
      })),
    });
    backstories.push({ id: `story-${id}`, synthetic: true, conversationId: id, text: story });
  }
  for (const r of relationships) {
    conversation(`direct-${r.id}`, 'Friends catch-up', [...r.memberIds], `${r.origin} This is a fictional relationship, not a real shared memory.`);
  }
  for (let c = 0; c < 10; c++) {
    const members = communities[c].memberIds;
    conversation(`circle-chat-${c + 1}`, circles[c][0], [...members], circles[c][2]);
    for (let t = 0; t < 3; t++) {
      conversation(`trio-${c + 1}-${t + 1}`, `${circles[c][0]} small plans ${t + 1}`,
        members.slice(t * 3, t * 3 + 3), 'This fictional trio is planning its next small-circle activity.');
    }
    conversation(`bridge-trio-${c + 1}`, 'Mutual introduction',
      [members[0], communities[(c + 1) % 10].memberIds[1], communities[(c + 1) % 10].memberIds[2]],
      'A fictional mutual friend introduced these people. They are still getting to know each other.');
  }
  for (let g = 0; g < 3; g++) {
    const members = Array.from({ length: 50 }, (_, i) => idFor((g * 25 + i) % 100));
    conversation(`community-chat-${g + 1}`, ['Community noticeboard', 'Weekend exchange', 'Local projects'][g], members,
      'This fictional community room brings several circles together. Most members are not personal friends.');
  }
  const world = {
    schemaVersion: 1, seed, synthetic: true,
    purpose: 'Offline social-world configuration; not a live account or message export.',
    knowledgePolicy: {
      historyScope: 'same-conversation-only',
      backstoryScope: 'same-conversation-only',
      groupMembershipCreatesFriendship: false,
      friendOfFriendGrantsHistoryAccess: false,
      liveRegistrationEnabled: false,
    },
    bots, communities, relationships, conversations, backstories,
  };
  validateWorld(world);
  return world;
}

export function validateWorld(world) {
  function require(condition, message) { if (!condition) throw new Error(message); }
  const unique = (values) => new Set(values).size === values.length;
  require(world.schemaVersion === 1 && world.synthetic === true, 'Unsupported or non-synthetic world.');
  require(world.bots.length === 100, 'Expected 100 bots.');
  const ids = world.bots.map((b) => b.id);
  const known = new Set(ids);
  require(unique(ids), 'Duplicate bot IDs.');
  for (const collection of ['communities', 'relationships', 'conversations', 'backstories']) {
    require(unique(world[collection].map((item) => item.id)), `Duplicate ${collection} IDs.`);
  }
  require(world.knowledgePolicy.historyScope === 'same-conversation-only'
    && world.knowledgePolicy.backstoryScope === 'same-conversation-only'
    && world.knowledgePolicy.groupMembershipCreatesFriendship === false
    && world.knowledgePolicy.friendOfFriendGrantsHistoryAccess === false
    && world.knowledgePolicy.liveRegistrationEnabled === false, 'Unsafe knowledge policy.');
  const validMembers = (members) => members.every((id) => known.has(id)) && unique(members);
  for (const b of world.bots) {
    require(b.synthetic === true && b.displayName.endsWith('(AI bot)'), 'Missing bot disclosure.');
    require(b.activity.activeHours.length === 2 && b.activity.activeHours[0] >= 0
      && b.activity.activeHours[0] < b.activity.activeHours[1] && b.activity.activeHours[1] <= 24, 'Invalid activity window.');
    require(b.activity.daysOfWeek.length > 0 && unique(b.activity.daysOfWeek)
      && b.activity.daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), 'Invalid activity days.');
  }
  const communityMembership = new Set();
  for (const c of world.communities) {
    require(c.memberIds.length === 10 && validMembers(c.memberIds), 'Invalid community membership.');
    for (const id of c.memberIds) {
      require(!communityMembership.has(id), 'Duplicate primary community.');
      require(world.bots.find((b) => b.id === id).communityId === c.id, 'Community mismatch.');
      communityMembership.add(id);
    }
  }
  require(communityMembership.size === 100, 'Missing primary community.');
  const adjacency = new Map(ids.map((id) => [id, new Set()]));
  const pairs = new Set();
  for (const r of world.relationships) {
    require(r.memberIds.length === 2 && validMembers(r.memberIds), 'Invalid relationship members.');
    require(['close-friend', 'friend', 'acquaintance'].includes(r.kind), 'Invalid relationship kind.');
    const [a, b] = r.memberIds;
    require(!pairs.has(pairKey(a, b)), 'Duplicate relationship pair.');
    pairs.add(pairKey(a, b));
    adjacency.get(a).add(b); adjacency.get(b).add(a);
  }
  const reached = new Set([ids[0]]);
  for (const id of reached) for (const peer of adjacency.get(id)) reached.add(peer);
  require(reached.size === 100, 'Disconnected social graph.');
  require([...adjacency.values()].every((peers) => peers.size >= 2 && peers.size <= 15), 'Graph must remain sparse with no isolated bots.');
  const sizes = new Set();
  const covered = new Set();
  const conversationIds = new Set(world.conversations.map((c) => c.id));
  const directPairs = new Set();
  for (const c of world.conversations) {
    require([2, 3, 10, 50].includes(c.memberIds.length) && validMembers(c.memberIds), 'Invalid conversation membership.');
    require(c.kind === (c.memberIds.length === 2 ? 'direct' : 'group'), 'Conversation kind mismatch.');
    require(c.participation.length === c.memberIds.length && unique(c.participation.map((p) => p.botId))
      && c.participation.every((p) => c.memberIds.includes(p.botId) && roles.includes(p.role)
        && Number.isFinite(p.replyWeight) && p.replyWeight >= 0 && p.replyWeight <= 1), 'Invalid participation.');
    sizes.add(c.memberIds.length);
    for (const id of c.memberIds) covered.add(id);
    if (c.kind === 'direct') {
      const pair = pairKey(...c.memberIds);
      require(pairs.has(pair) && !directPairs.has(pair), 'Direct conversation relationship mismatch.');
      directPairs.add(pair);
    }
  }
  require(directPairs.size === pairs.size, 'Missing relationship conversation.');
  require(sizes.size === 4 && covered.size === 100, 'Missing conversation sizes or bots.');
  for (const [size, count] of [[3, 40], [10, 10], [50, 3]]) {
    require(world.conversations.filter((c) => c.memberIds.length === size).length === count, 'Unexpected group counts.');
  }
  const largeRoomMembers = new Set(world.conversations.filter((c) => c.memberIds.length === 50).flatMap((c) => c.memberIds));
  require(largeRoomMembers.size === 100, 'Large rooms must cover all bots.');
  const storyScopes = world.backstories.map((s) => s.conversationId);
  require(unique(storyScopes) && storyScopes.length === conversationIds.size, 'Expected one backstory per conversation.');
  for (const s of world.backstories) require(s.synthetic === true && conversationIds.has(s.conversationId), 'Invalid backstory scope.');
  return world;
}

// This projection is a fixture contract, not live authorization. A future runner must
// check current authenticated MLS membership and consent before building any prompt.
// No private history or other bots' personas are included in this configuration view.
export function getConversationContext(world, botId, conversationId) {
  const bot = world.bots.find((b) => b.id === botId);
  const conversation = world.conversations.find((c) => c.id === conversationId);
  if (!bot || !conversation || !conversation.memberIds.includes(botId)) throw new Error('Not a conversation member.');
  const memberIds = new Set(conversation.memberIds);
  return structuredClone({
    self: bot,
    conversation,
    members: world.bots.filter((b) => memberIds.has(b.id)).map(({ id, displayName }) => ({ id, displayName })),
    relationships: world.relationships.filter((r) => r.memberIds.includes(botId) && r.memberIds.every((id) => memberIds.has(id))),
    backstories: world.backstories.filter((s) => s.conversationId === conversationId),
  });
}

export function summarizeWorld(world) {
  return {
    bots: world.bots.length,
    communities: world.communities.length,
    relationships: world.relationships.length,
    conversationsBySize: Object.fromEntries([2, 3, 10, 50].map((size) => [size, world.conversations.filter((c) => c.memberIds.length === size).length])),
  };
}
