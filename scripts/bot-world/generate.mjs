#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DEFAULT_SEED, generateWorld, summarizeWorld } from './world.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || !/^\d+$/.test(args[0])) {
  console.error(`Usage: node scripts/bot-world/generate.mjs <uint32-seed> <output.json>\nDefault fixture seed: ${DEFAULT_SEED}`);
  process.exitCode = 1;
} else {
  try {
    const world = generateWorld(Number(args[0]));
    const output = resolve(args[1]);
    await mkdir(dirname(output), { recursive: true });
    // Refuse to overwrite existing data. Regenerate to a new path and compare first.
    await writeFile(output, `${JSON.stringify(world, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ output, ...summarizeWorld(world) }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
