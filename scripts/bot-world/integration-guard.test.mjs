import test from 'node:test';
import assert from 'node:assert/strict';
import { runIntegration } from './integration.mjs';

// Every case must reject before creating a socket, process, or state directory.
test('real-server integration refuses missing, remote, production-named, and URL-override databases', async () => {
  const invalid = [
    '', 'not-a-url',
    'postgres://test:secret@example.com/chat_bots_test',
    'postgres://test:secret@127.0.0.1/postgres',
    'postgres://test:secret@127.0.0.1/chat_bots_test?host=example.com',
    'postgres://test:secret@127.0.0.1/chat_bots_test#fragment',
    'https://127.0.0.1/chat_bots_test',
  ];
  for (const databaseUrl of invalid) {
    await assert.rejects(runIntegration({ databaseUrl }), (error) => {
      assert.ok(!error.message.includes('secret'));
      return error.phase === 'database-guard' && error.message === 'Isolated native integration failed safely.';
    });
  }
});
