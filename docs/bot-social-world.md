# Synthetic bot social world

This is an **offline configuration**, not a live bot deployment. It contains 100
fictional, explicitly labelled AI bot profiles. It creates no accounts, keys,
messages, network requests, model calls, or database memberships.

## Run

Requires Node.js 22 or newer. There are no additional dependencies.

```sh
pnpm bots:world:test
pnpm bots:world:generate 20261111 /tmp/bot-world.json
```

The command refuses to overwrite an existing file. Run with a different output
path to compare regenerated data. Direct invocation also works:

```sh
node scripts/bot-world/generate.mjs 20261111 /tmp/bot-world-new.json
node --test scripts/bot-world/world.test.mjs
```

The checked-in sample is `fixtures/bot-world/default.json`. Seed `20261111`
reproduces its bytes. Generator changes can change the output; the seed alone
is not a promise of compatibility across generator versions.

## Default network

| Item | Count |
|------|-------|
| Bots | 100 |
| Primary interest circles | 10 |
| Explicit social relationships | 190 |
| Direct conversations (2 members) | 190 |
| Small groups (3 members) | 40 |
| Circle groups (10 members) | 10 |
| Community groups (50 members) | 3 |

Every bot has one primary circle and at least 2 social connections. Friends
within circles, links between neighbouring circles, and seeded longer-range
acquaintances form one connected, sparse graph. Relationships are reciprocal,
but group co-membership does **not** create a friendship. There are many
friends-of-friends who are not direct friends. Consecutive large groups overlap by
25 members; the first and third do not overlap. Together they cover all 100 bots.

The graph structure stays similar across seeds; the seed changes personalities,
activity preferences, and long-range acquaintances. This is a designed social
fixture, not a claim of statistical realism or a simulation of actual people.

## Format (schema version 1)

`schemaVersion`, `seed`, and `synthetic` identify the dataset. IDs are stable
fixture identifiers, **not** account IDs, device IDs, or MLS conversation IDs.

- `bots`: distinct names labelled `(AI bot)`, primary circle, personality,
  interests, writing style, fictional personal detail, and activity preferences.
- `activity`: UTC start/end hours (end exclusive), days numbered Sunday `0`
  through Saturday `6`, and sociability. These are preferences, not a scheduler.
- `communities`: primary interest circles with 10 members each.
- `relationships`: unordered pairs of bot IDs with a kind (`close-friend`,
  `friend`, or `acquaintance`) and a fictional meeting origin. Each pair appears
  once. These are social facts known to the participants, not message history.
- `conversations`: IDs, names, exact member lists, and per-member participation
  preferences. `direct` means 2 members; the other supported sizes are groups.
- `participation`: a room-specific role and a relative `replyWeight` from 0 to 1.
  A future scheduler must select speakers; a weight is **not** permission to
  reply to every message. Quiet and occasional members have lower weights.
- `backstories`: explicitly synthetic shared setup, scoped to exactly one
  conversation. No generated chat transcripts or claimed real memories.
- `knowledgePolicy`: fixed restrictions against cross-conversation history,
  automatic friendships from group membership, or live registration.

## Knowledge boundaries

`getConversationContext(world, botId, conversationId)` rejects nonmembers. It
returns a detached configuration view with:

1. The bot's own profile.
2. The selected room and its public member labels.
3. The bot's own relationships to members of that room.
4. Only that room's fictional shared setup.

It does not include other profiles' personalities, other conversations, or
other rooms' shared setup. Knowing a person who knows someone else does not
provide access to either person's private chats. Mutating a returned view does
not mutate the source world.

**This helper is not a live authorization or security boundary.** The complete
fixture is synthetic and available to the operator. A live runner must keep
real keys and private histories isolated, verify current authenticated MLS
membership, respect removals, and scope retrieved history to the selected
conversation before constructing a prompt. The world tests validate configuration
boundaries only, not runtime encryption, consent, or inference privacy.

## Separate opt-in runner

The [opt-in bot runner](ai-bots.md) defaults to local random text (ADR-0045), with
optional AI mode. It registers accounts through supported APIs,
creates real MLS conversations, and maps fixture IDs to account/conversation IDs.
It does not insert memberships directly in the server database. Bots must be
clearly disclosed; human participants must consent before conversation context
is sent to a hosted AI provider. Existing private conversations must not gain
bots silently. Generating or opening this dataset does not activate the runner.

See [ADR-0043](adr/0043-offline-bot-social-world.md).
