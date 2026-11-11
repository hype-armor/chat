#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generateWorld, summarizeWorld, validateWorld } from './world.mjs';
import { FreeProvider, buildPrompt } from './provider.mjs';
import { StateStore, stateKey } from './store.mjs';
import { BotController } from './controller.mjs';
import { NativeTransport } from './transport.mjs';

const mode = process.argv[2] ?? 'plan';
let store, transport, controller, stopping = false;
async function shutdown() {
  stopping = true;
  await controller?.stop(); transport?.close();
}
try {
  if (!['plan', 'bootstrap', 'run'].includes(mode) || process.argv.length > 3) throw new Error('Usage: node scripts/bot-world/run.mjs [plan|bootstrap|run]');
  const world = process.env.CHAT_BOT_WORLD_FILE
    ? validateWorld(JSON.parse(await readFile(process.env.CHAT_BOT_WORLD_FILE, 'utf8'))) : generateWorld();
  if (mode === 'plan') {
    console.log(JSON.stringify({ ...summarizeWorld(world), model: process.env.CHAT_BOT_AI_MODEL ?? 'openrouter/free', activated: false, note: 'No accounts created, network requests, or model calls.' }, null, 2));
  } else {
    if (process.env.CHAT_BOTS_ENABLED !== 'true') throw new Error('Set CHAT_BOTS_ENABLED=true to explicitly enable bot network operations.');
    const server = new URL(process.env.CHAT_BOT_SERVER ?? 'http://127.0.0.1:8080');
    if (!['https:', 'http:'].includes(server.protocol) || server.username || server.password || server.search || server.hash
      || (server.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(server.hostname))) throw new Error('Use HTTPS, or loopback HTTP for isolated tests.');
    const directory = resolve(process.env.CHAT_BOT_STATE_DIR ?? 'bot-state');
    process.env.CHAT_BOT_STATE_DIR = resolve(directory, 'transport');
    process.env.CHAT_BOT_SERVER = server.href.replace(/\/$/, '');
    const provider = new FreeProvider({ apiKey: mode === 'bootstrap' ? 'unused-bootstrap-key' : process.env.CHAT_BOT_AI_API_KEY });
    const binding = createHash('sha256').update(JSON.stringify({ server: server.href, world })).digest('hex');
    store = new StateStore(resolve(directory, 'controller'), stateKey(process.env.CHAT_BOT_STATE_KEY));
    await store.lock();
    const state = await store.load();
    let events = Promise.resolve();
    let fatal = false;
    transport = new NativeTransport(resolve(process.env.CHAT_BOT_BINARY ?? 'target/debug/chat-bot'), {
      onEvent: (event) => {
        // sendResult is a transient hint. The persisted operation is polled
        // through send/create; only durable events carry an ackable ID.
        if (!event.eventId) return;
        controller?.observe(event);
        events = events.then(async () => {
          await controller.event(event);
          await transport.request('ackEvent', { eventId: event.eventId });
        }).catch(() => { fatal = true; void shutdown(); });
      },
      onFailure: () => { if (!stopping) { fatal = true; void shutdown(); } },
    });
    controller = new BotController({ world, transport, provider, store, state, binding, buildPrompt,
      dailyLimit: Number(process.env.CHAT_BOT_DAILY_REQUESTS ?? 50),
      requestsPerMinute: Number(process.env.CHAT_BOT_REQUESTS_PER_MINUTE ?? 10),
    });
    await controller.save();
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    async function connect(botId) {
      await transport.request('connect', { botId });
      const deadline = Date.now() + 60000;
      while (!stopping && !controller.connected.has(botId)) {
        if (Date.now() > deadline) throw new Error('Native bot connection timed out.');
        await delay(100); await events;
      }
    }
    if (mode === 'bootstrap') {
      const prefix = process.env.CHAT_BOT_USERNAME_PREFIX ?? 'ai_bot';
      if (!/^[a-z][a-z0-9_]{2,19}$/.test(prefix) || !prefix.includes('bot')) throw new Error('Invalid bot username prefix; include bot explicitly.');
      const limit = Number(process.env.CHAT_BOT_BOOTSTRAP_LIMIT ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Bootstrap limit must be 1 through 100.');
      const invites = process.env.CHAT_BOT_INVITES_FILE ? JSON.parse(await readFile(process.env.CHAT_BOT_INVITES_FILE, 'utf8')) : {};
      for (let i = 0; i < Math.min(limit, world.bots.length) && !stopping; i++) {
        const bot = world.bots[i];
        const account = await transport.request('register', { botId: bot.id, username: `${prefix}.${String(i + 1).padStart(4, '0')}`, invite: invites[bot.id], displayName: bot.displayName });
        await controller.exclusive(async () => { controller.state.accounts[bot.id] = account; await controller.save(); });
        await connect(bot.id);
        console.log(`Bot ${i + 1}/${limit} ready.`);
      }
      for (const room of world.conversations) {
        if (stopping) break;
        if (!room.memberIds.every((id) => controller.state.accounts[id])) continue;
        const [botId, ...memberBotIds] = room.memberIds;
        const deadline = Date.now() + 120000;
        while (!stopping) {
          const created = await transport.request('create', { botId, fixtureConversationId: room.id, memberBotIds, name: room.name,
            displayName: world.bots.find((bot) => bot.id === botId).displayName });
          await controller.exclusive(async () => { controller.state.fixtures[room.id] = created.conversationId; await controller.save(); });
          if (created.accepted === true) break;
          if (Date.now() > deadline) throw new Error('Native bot creation is still pending.');
          await delay(250); await events;
        }
      }
      await events;
      console.log('Bootstrap progress saved. Registration and welcome limits still apply; rerun to resume.');
    } else {
      if (!Object.keys(controller.state.accounts).length) throw new Error('Bootstrap at least 2 bots before running.');
      for (const botId of Object.keys(controller.state.accounts)) {
        if (stopping) break;
        await connect(botId);
      }
      console.log('Bot runner active. Inference waits for connected members, consent, schedules, and quotas.');
      while (!stopping) {
        await events;
        try { await controller.tick(); }
        catch (error) {
          if (!error.nativeOperation) throw error;
          // A queued membership/revocation event can fence a send. Let the
          // durable event queue advance before retrying the same operation.
          await delay(5000);
        }
        await delay(1000);
      }
    }
    if (fatal) throw new Error('Bot runner stopped after a transport or persistence failure.');
    await shutdown(); await events;
  }
} catch (error) {
  // Never print arbitrary provider/transport error objects, URLs, bodies, or credentials.
  const safeMessages = ['Usage:', 'Set CHAT_BOTS_ENABLED', 'Use HTTPS', 'Bootstrap at least', 'Invalid bot username', 'Bootstrap limit', 'CHAT_BOT_STATE_KEY', 'Controller state', 'AI provider API key', 'AI provider model', 'Invalid inference limits'];
  console.error(safeMessages.some((prefix) => error.message?.startsWith(prefix)) ? error.message : 'Bot runner failed safely. Check configuration, isolated-service availability, quotas, and state-directory ownership.');
  process.exitCode = 1;
} finally {
  await shutdown();
  await store?.close();
}
