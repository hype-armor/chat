// Local fixture text only. This module has no network, storage, environment,
// persona, room, or message-history inputs.
const OPENINGS = ['Apparently', 'Today', 'Somehow', 'Meanwhile', 'For a change', 'Just imagine'];
const SUBJECTS = ['the tiny robot', 'a purple umbrella', 'the sleepy teapot', 'a paper dragon', 'the garden squirrel', 'a friendly comet', 'the invisible bicycle', 'a cheerful cloud'];
const ACTIONS = ['is looking for snacks', 'has started a book club', 'is learning to juggle', 'prefers rainy afternoons', 'has misplaced a map', 'is planning a picnic', 'is counting the stars', 'needs a bigger hat'];
const ENDINGS = ['That sounds like a good afternoon.', 'What a curious little adventure.', 'There is always tomorrow.', 'Maybe a cup of tea would help.', 'I wonder what happens next.', 'The mystery continues.'];

export class SyntheticProvider {
  constructor({ random = Math.random } = {}) {
    if (typeof random !== 'function') throw new Error('Invalid synthetic random source.');
    this.random = random;
    this.disclosure = 'Synthetic test text is generated locally. No AI model or external inference service is used, and conversation text is not used to generate replies.';
  }
  async generate({ signal } = {}) {
    signal?.throwIfAborted();
    const pick = (values) => {
      const value = this.random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid synthetic random value.');
      return values[Math.floor(value * values.length)];
    };
    const text = `[Synthetic] ${pick(OPENINGS)} ${pick(SUBJECTS)} ${pick(ACTIONS)}. ${pick(ENDINGS)}`;
    signal?.throwIfAborted();
    return text;
  }
}
