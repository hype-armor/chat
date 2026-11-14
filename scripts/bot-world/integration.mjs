#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isIP } from 'node:net';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { generateWorld } from './world.mjs';
import { BotController, initialState } from './controller.mjs';
import { NativeTransport } from './transport.mjs';
import { StateStore } from './store.mjs';

const LIMIT_MS = 12_000;
const READY_MS = 30_000;
const GENERATED_REPLY = 'Mock inference reply for the isolated native integration check.';
const PHASES = new Set(['database-guard', 'server-ready', 'register', 'connect', 'create', 'pre-consent', 'disclosure', 'consent', 'post-consent', 'inference', 'stop', 'cleanup']);

function phaseFailure(phase) {
  const error = new Error('Isolated native integration failed safely.');
  error.phase = PHASES.has(phase) ? phase : 'server-ready';
  return error;
}

function guardDatabaseUrl(value) {
  if (typeof value !== 'string' || !value) throw new Error('BOT_TEST_DATABASE_URL is required.');
  let url;
  try { url = new URL(value); } catch { throw new Error('BOT_TEST_DATABASE_URL is invalid.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1'
    || (isIP(host) === 4 && Number(host.split('.')[0]) === 127);
  let database;
  try { database = decodeURIComponent(url.pathname.replace(/^\//, '')); }
  catch { throw new Error('BOT_TEST_DATABASE_URL is invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !loopback || url.search || url.hash
    || !database.startsWith('chat_bots_test') || database.includes('/')) {
    throw new Error('Refusing database: use a loopback PostgreSQL URL with a chat_bots_test database name.');
  }
  return value;
}

function bounded(promise, ms = LIMIT_MS, label = 'Integration operation timed out.') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function freePort() {
  const listener = createServer();
  await bounded(new Promise((resolveListen, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolveListen);
  }), 3000, 'Could not reserve a loopback port.');
  const { port } = listener.address();
  await bounded(new Promise((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose())), 3000, 'Could not release a loopback port.');
  return port;
}

async function waitFor(check, { timeoutMs = LIMIT_MS, intervalMs = 100, label = 'Condition timed out.' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await bounded(check(), Math.min(LIMIT_MS, Math.max(1000, deadline - Date.now())), label);
    if (result) return result;
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(label);
}

async function request(transport, op, args = {}) {
  return bounded(transport.request(op, args), LIMIT_MS, `Native ${op} timed out.`);
}

async function pollAccepted(transport, op, args, acceptedValue, label, drainEvents) {
  return waitFor(async () => {
    let result;
    try { result = await request(transport, op, args); }
    catch (error) {
      if (!error.nativeOperation) throw error;
      await drainEvents();
      return null;
    }
    if (result.accepted === acceptedValue) {
      await drainEvents();
      return result;
    }
    await drainEvents();
    return null;
  }, { timeoutMs: 30_000, intervalMs: 150, label });
}

function spawnServer(binary, databaseUrl, port) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? process.cwd(),
    DATABASE_URL: databaseUrl,
    CHAT_BIND: `127.0.0.1:${port}`,
    CHAT_REGISTRATION: 'open',
    CHAT_METRICS_BIND: '',
    CHAT_BLOB_STORE: 'memory',
    CHAT_LOG_FORMAT: 'pretty',
  };
  const child = spawn(binary, [], { cwd: process.cwd(), env, stdio: 'ignore' });
  child.integrationSpawnError = false;
  child.on('error', () => { child.integrationSpawnError = true; });
  return child;
}

async function waitReady(server, baseUrl) {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    if (server.integrationSpawnError || server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated chat server exited before readiness.');
    try {
      const response = await bounded(fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1500), redirect: 'error' }), 2000, 'Readiness request timed out.');
      if (response.ok) return;
    } catch { /* Retry the local readiness probe until the bounded deadline. */ }
    await delay(100);
  }
  throw new Error('Isolated chat server did not become ready.');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
}

export async function runIntegration({ databaseUrl = process.env.BOT_TEST_DATABASE_URL, generationMode = 'ai' } = {}) {
  let phase = 'database-guard';
  // This validation must finish before any socket, subprocess, or HTTP activity.
  let guardedDatabaseUrl;
  try {
    if (!['ai', 'synthetic'].includes(generationMode)) throw new Error('Invalid generation mode.');
    guardedDatabaseUrl = guardDatabaseUrl(databaseUrl);
  } catch { throw phaseFailure(phase); }
  phase = 'server-ready';
  let root;
  try {
    root = await mkdtemp(join(process.cwd(), '.bot-world-integration-'));
    await chmod(root, 0o700);
  } catch {
    if (root) { try { await rm(root, { recursive: true, force: true }); } catch { /* Cleanup only. */ } }
    throw phaseFailure(phase);
  }
  let server;
  let transport;
  let store;
  let controller;
  let eventChain = Promise.resolve();
  let transportFailed = false;
  let stopping = false;
  let failurePending = false;
  let cleanupFailed = false;
  const connected = new Set();
  const decryptedMessages = [];
  const providerPrompts = [];
  const generatedReplies = [];
  const syntheticCalls = [];
  let eventCount = 0;
  const drainEvents = async () => {
    await bounded(eventChain, LIMIT_MS, 'Native event processing timed out.');
    if (transportFailed) throw new Error('Native event processing failed.');
  };
  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const serverBinary = resolve(process.env.BOT_TEST_SERVER_BINARY ?? 'target/debug/chat-server');
    const workerBinary = resolve(process.env.BOT_TEST_CHAT_BOT_BINARY ?? 'target/debug/chat-bot');
    server = spawnServer(serverBinary, guardedDatabaseUrl, port);
    await waitReady(server, baseUrl);

    const workerKey = randomBytes(32);
    const workerKeyBase64 = workerKey.toString('base64');
    workerKey.fill(0);
    const controllerKey = randomBytes(32);
    const storeDir = join(root, 'controller');
    store = new StateStore(storeDir, controllerKey);
    await store.lock();
    const loadedState = await store.load();
    const world = structuredClone(generateWorld());
    for (const bot of world.bots) {
      bot.activity.activeHours = [0, 24];
      bot.activity.daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
    }
    const fixtureId = 'trio-1-1';
    const fixture = world.conversations.find((item) => item.id === fixtureId);
    if (!fixture || fixture.memberIds.length !== 3) throw new Error('Expected the three-member test fixture.');
    const [botOne, botTwo, humanBotId] = fixture.memberIds;
    let mockProvider;
    if (generationMode === 'synthetic') {
      const { SyntheticProvider } = await import('./synthetic.mjs');
      const syntheticProvider = new SyntheticProvider();
      mockProvider = {
        disclosure: 'Synthetic local text provider for isolated integration testing.',
        async generate(input) {
          syntheticCalls.push({ keys: Object.keys(input).sort(), signal: input.signal });
          const reply = await syntheticProvider.generate(input);
          generatedReplies.push(reply);
          return reply;
        },
      };
    } else {
      mockProvider = {
        disclosure: 'Mock inference provider for isolated integration testing. No external inference is used.',
        async generate(input) {
          providerPrompts.push(structuredClone({ system: input.system, messages: input.messages }));
          return GENERATED_REPLY;
        },
      };
    }
    const binding = `integration-${randomUUID()}`;
    const state = loadedState ?? initialState(binding);
    controller = new BotController({
      world, transport: null, provider: mockProvider, store, state, binding,
      buildPrompt: (await import('./provider.mjs')).buildPrompt,
      mode: generationMode,
      dailyLimit: 50, requestsPerMinute: 10,
    });
    const nativeEnv = {
      CHAT_BOTS_ENABLED: 'true',
      CHAT_BOT_SERVER: baseUrl,
      CHAT_BOT_STATE_DIR: join(root, 'native'),
      CHAT_BOT_STATE_KEY: workerKeyBase64,
    };
    transport = new NativeTransport(workerBinary, {
      env: nativeEnv,
      onEvent(event) {
        if (!event.eventId) return;
        eventCount++;
        if (event.event === 'connected') connected.add(event.botId);
        if (event.event === 'message' && typeof event.text === 'string') {
          decryptedMessages.push({ botId: event.botId, senderAccountId: event.senderAccountId, text: event.text });
        }
        controller?.observe(event);
        eventChain = eventChain.then(async () => {
          await controller.event(event);
          await request(transport, 'ackEvent', { eventId: event.eventId });
        }).catch(() => { transportFailed = true; });
      },
      onFailure() { if (!stopping) transportFailed = true; },
    });
    controller.transport = transport;
    const tickWithRetry = async () => {
      try { await bounded(controller.tick(), LIMIT_MS, 'Coordinator tick timed out.'); }
      catch (error) {
        if (!error.nativeOperation) throw error;
        await drainEvents();
      }
      await drainEvents();
    };

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    phase = 'register';
    const accounts = new Map();
    const usernamePrefix = `bot${suffix}`;
    for (const [index, botId] of [botOne, botTwo, humanBotId].entries()) {
      const username = `${usernamePrefix}.${String(index + 1).padStart(4, '0')}`;
      const displayName = world.bots.find((bot) => bot.id === botId).displayName;
      const account = await request(transport, 'register', { botId, username, displayName });
      accounts.set(botId, account);
    }
    await controller.exclusive(async () => {
      controller.state.accounts[botOne] = accounts.get(botOne);
      controller.state.accounts[botTwo] = accounts.get(botTwo);
      // The third native identity is intentionally absent from this map, so it is a human to the coordinator.
      await controller.save();
    });

    phase = 'connect';
    for (const botId of [botOne, botTwo, humanBotId]) await request(transport, 'connect', { botId });
    await waitFor(() => {
      if (transportFailed) throw new Error('Native transport or event processing failed.');
      return [botOne, botTwo, humanBotId].every((botId) => connected.has(botId));
    }, { timeoutMs: 30_000, label: 'Native identities did not connect.' });
    await drainEvents();

    phase = 'create';
    const created = await pollAccepted(transport, 'create', {
      botId: botOne, fixtureConversationId: fixtureId, memberBotIds: [botTwo, humanBotId],
      name: fixture.name, displayName: world.bots.find((bot) => bot.id === botOne).displayName,
    }, true, 'Native MLS room creation was not accepted.', drainEvents);
    const conversationId = created.conversationId;
    if (typeof conversationId !== 'string' || !conversationId) throw new Error('Native room creation returned no identifier.');
    await controller.exclusive(async () => {
      controller.state.fixtures[fixtureId] = conversationId;
      await controller.save();
    });
    await waitFor(async () => {
      await drainEvents();
      const room = controller.state.rooms[conversationId];
      return room?.members?.length === 3 && room.membershipKey ? room : null;
    }, { timeoutMs: 20_000, label: 'Coordinator did not observe the three-member MLS room.' });

    phase = 'pre-consent';
    const humanMemberData = { botId: humanBotId, conversationId };
    const initialMembership = await request(transport, 'members', humanMemberData);
    if (initialMembership.members.length !== 3) throw new Error('Native MLS membership did not contain 3 identities.');
    const humanAccount = accounts.get(humanBotId);
    const preConsentText = `integration-pre-consent-${suffix}`;
    const preConsentOperation = `pre-consent-${randomUUID()}`;
    await pollAccepted(transport, 'send', {
      ...humanMemberData, operationId: preConsentOperation, expectedMembershipKey: initialMembership.membershipKey, text: preConsentText,
    }, true, 'Pre-consent native message was not accepted.', drainEvents);
    await waitFor(async () => {
      await drainEvents();
      if (!decryptedMessages.some((message) => message.text === preConsentText)) return null;
      const room = controller.state.rooms[conversationId];
      return room && !room.history.some((item) => item.text.includes(preConsentText));
    }, { timeoutMs: 15_000, label: 'Pre-consent message was not observed or entered coordinator context.' });
    if (providerPrompts.length !== 0) throw new Error('Inference ran before consent.');

    phase = 'disclosure';
    await waitFor(async () => {
      await tickWithRetry();
      return controller.state.rooms[conversationId]?.disclosed === true;
    }, { timeoutMs: 20_000, intervalMs: 150, label: 'Coordinator disclosure was not accepted.' });
    phase = 'consent';
    const room = controller.state.rooms[conversationId];
    const consentText = `${generationMode === 'synthetic' ? '/bots' : '/ai'} consent ${room.nonce}`;
    const beforeConsentMembership = await request(transport, 'members', humanMemberData);
    await pollAccepted(transport, 'send', {
      ...humanMemberData, operationId: `consent-${randomUUID()}`,
      expectedMembershipKey: beforeConsentMembership.membershipKey, text: consentText,
    }, true, 'Native human consent message was not accepted.', drainEvents);
    await waitFor(async () => {
      await drainEvents();
      return room.consent.includes(humanAccount.accountId);
    }, { timeoutMs: 15_000, label: 'Authenticated human consent was not recorded.' });

    phase = 'post-consent';
    const postConsentText = `integration-post-consent-${suffix}`;
    const postConsentMembership = await request(transport, 'members', humanMemberData);
    await pollAccepted(transport, 'send', {
      ...humanMemberData, operationId: `post-consent-${randomUUID()}`,
      expectedMembershipKey: postConsentMembership.membershipKey, text: postConsentText,
    }, true, 'Post-consent native message was not accepted.', drainEvents);
    if (generationMode === 'synthetic') {
      await waitFor(async () => { await drainEvents(); return room.syntheticTriggered === true; },
        { timeoutMs: 15_000, label: 'Post-consent synthetic trigger was not observed.' });
      if (room.history.length !== 0) throw new Error('Synthetic mode retained human text.');
    } else {
      await waitFor(async () => {
        await drainEvents();
        return room.history.some((item) => item.text === postConsentText);
      }, { timeoutMs: 15_000, label: 'Post-consent message was not added to room context.' });
    }
    if (room.history.some((item) => item.text.includes(preConsentText))) throw new Error('Pre-consent text was retained.');
    phase = 'inference';
    await controller.exclusive(async () => {
      room.lastAt = Date.now() - 180_000;
      if (generationMode === 'synthetic') room.nextAt = 0;
      await controller.save();
    });
    await waitFor(async () => {
      await tickWithRetry();
      const replies = generationMode === 'synthetic' ? generatedReplies : [GENERATED_REPLY];
      return replies.length > 0 && replies.some((reply) => decryptedMessages.some((message) => message.text === reply));
    }, { timeoutMs: 30_000, intervalMs: 100, label: 'Generated reply was not decrypted from native MLS traffic.' });
    if (generationMode === 'synthetic') {
      if (syntheticCalls.some((input) => input.keys.join(',') !== 'signal' || !(input.signal instanceof AbortSignal))) throw new Error('Synthetic provider received non-signal input.');
      if (providerPrompts.length !== 0 || room.history.length !== 0) throw new Error('Synthetic mode retained or submitted human text.');
    } else {
      if (providerPrompts.some((prompt) => JSON.stringify(prompt).includes(preConsentText))) throw new Error('Pre-consent text reached mock inference.');
      if (!providerPrompts.some((prompt) => JSON.stringify(prompt).includes(postConsentText))) throw new Error('Post-consent text did not reach mock inference.');
    }

    phase = 'stop';
    const stopMembership = await request(transport, 'members', humanMemberData);
    await pollAccepted(transport, 'send', {
      ...humanMemberData, operationId: `stop-${randomUUID()}`,
      expectedMembershipKey: stopMembership.membershipKey, text: generationMode === 'synthetic' ? '/bots stop' : '/ai stop',
    }, true, 'Native stop command was not accepted.', drainEvents);
    await waitFor(async () => {
      await drainEvents();
      return room.paused && room.history.length === 0 && room.consent.length === 0;
    }, { timeoutMs: 15_000, label: 'Stop command did not clear consent and context.' });
    await controller.stop();
    await drainEvents();
    if (transportFailed) throw new Error('Native transport reported a failure.');
    return { ok: true, mode: generationMode, registeredIdentities: accounts.size, managedBots: 2, humanIdentities: 1, roomMembers: 3, providerCalls: providerPrompts.length, generatedMessages: generatedReplies.length, decryptedMessages: decryptedMessages.length, events: eventCount };
  } catch {
    failurePending = true;
    throw phaseFailure(phase);
  } finally {
    phase = 'cleanup';
    stopping = true;
    try { await controller?.stop(); } catch { cleanupFailed = true; }
    try {
      if (transport && !transport.closed) transport.close();
      if (transport) await stopChild(transport.child);
      await bounded(eventChain, 2000, 'Final cleanup event wait timed out.');
    } catch { cleanupFailed = true; }
    try { await stopChild(server); } catch { cleanupFailed = true; }
    try { await store?.close(); } catch { cleanupFailed = true; }
    try { await rm(root, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed && !failurePending) throw phaseFailure('cleanup');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const generationMode = process.env.BOT_TEST_MODE ?? 'ai';
    const result = await runIntegration({ generationMode });
    console.log(`Isolated native integration passed: ${JSON.stringify(result)}.`);
  } catch (error) {
    const phase = PHASES.has(error?.phase) ? error.phase : 'server-ready';
    console.error(`Isolated native integration failed at phase: ${phase}.`);
    process.exitCode = 1;
  }
}
