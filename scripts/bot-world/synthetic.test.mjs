import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticProvider } from './synthetic.mjs';

test('synthetic text is local, clearly labelled, bounded, and independent of supplied content', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Synthetic generation must not use the network.'); };
  try {
    const provider = new SyntheticProvider({ random: () => 0 });
    const text = await provider.generate({ messages: [{ content: 'private-human-sentinel' }], system: 'private-system-sentinel' });
    assert.match(text, /^\[Synthetic\] /);
    assert.ok(text.length < 240);
    assert.ok(!text.includes('sentinel'));
    assert.equal(text, await provider.generate());
    assert.match(provider.disclosure, /No AI model or external inference/);
    assert.notEqual(text, await new SyntheticProvider({ random: () => 0.999999 }).generate());
  } finally { globalThis.fetch = originalFetch; }
});

test('synthetic generation honors cancellation and rejects invalid random values', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(new SyntheticProvider().generate({ signal: abort.signal }), { name: 'AbortError' });
  for (const value of [-1, 1, Infinity, NaN]) {
    await assert.rejects(new SyntheticProvider({ random: () => value }).generate(), /Invalid synthetic random value/);
  }
  assert.throws(() => new SyntheticProvider({ random: null }), /Invalid synthetic random source/);
});
