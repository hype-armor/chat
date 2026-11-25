#!/usr/bin/env node
// Opt-in only. Never builds artifacts or enables topic transport.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const OLD_COMMIT = '4141dbd3c87a7bd2fa09d4359a969de7a73458c3'
export const CURRENT_COMMIT = '908f69a5e185b5b644030003ec4a531bbfcd2983'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// Each import has a distinct module identity, even for identical JS bytes.
// wasm-bindgen keeps its instance in module-level mutable state.
export async function loadPackage(directory, role, expectedCommit) {
  const dir = await realpath(directory)
  const js = await readFile(resolve(dir, 'chat_core.js'))
  const wasm = await readFile(resolve(dir, 'chat_core_bg.wasm'))
  if (expectedCommit) {
    const manifest = JSON.parse(await readFile(resolve(dir, 'topic-compat-build.json'), 'utf8'))
    assert.equal(manifest.sourceCommit, expectedCommit, `${role}: wrong source commit`)
    assert.equal(manifest.jsSha256, sha256(js), `${role}: JS checksum mismatch`)
    assert.equal(manifest.wasmSha256, sha256(wasm), `${role}: WASM checksum mismatch`)
  }
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${js}\n// isolated role: ${role}\n`).toString('base64')}`)
  module.initSync({ module: wasm })
  return { module, dir, jsHash: sha256(js), wasmHash: sha256(wasm) }
}

export function exchange(current, legacy, mixed = true) {
  assert.notEqual(current.CoreClient, legacy.CoreClient, 'JS modules must be isolated')
  assert.equal(typeof current.CoreClient.prototype.sendGroupTopic, 'function')
  if (mixed) assert.equal(typeof legacy.CoreClient.prototype.sendGroupTopic, 'undefined', 'old package must predate topics')
  const allocated = []
  const keep = value => { allocated.push(value); return value }
  try {
    const alice = keep(keep(new current.PendingClient()).intoClient(new Uint8Array(32).fill(1)))
    let bob = keep(keep(new legacy.PendingClient()).intoClient(new Uint8Array(32).fill(2)))
    const started = keep(alice.startConversation([bob.identity()], bob.keyPackages(1), new Uint8Array(16).fill(1)))
    const id = started.conversationId
    assert.equal(keep(bob.receive(started.welcome)).kind, 'joined')
    const text = (body, n) => alice.sendText(id, body, n, new Uint8Array(16).fill(n), undefined, undefined)
    assert.equal(keep(bob.receive(text('before topic', 2))).text, 'before topic')
    const topic = alice.sendGroupTopic(id, 'compatibility probe', 1, 3, new Uint8Array(16).fill(3))
    const event = keep(bob.receive(topic))
    assert.equal(event.kind, mixed ? 'ignored' : 'groupTopic')
    assert.equal(event.text, undefined)
    if (!mixed) assert.equal(event.groupTopicText, 'compatibility probe')
    // Copy the snapshot, destroy the receiver, and restore with the OLD class.
    const snapshot = Uint8Array.from(bob.snapshot())
    assert.ok(snapshot.length > 0)
    allocated.splice(allocated.indexOf(bob), 1)
    bob.free()
    bob = keep(legacy.CoreClient.restore(snapshot))
    snapshot.fill(0)
    const after = keep(bob.receive(text('after topic and restore', 4)))
    assert.equal(after.kind, 'message')
    assert.equal(after.text, 'after topic and restore')
    assert.deepEqual(after.sender, alice.identity())
  } finally {
    for (const value of allocated.reverse()) value.free()
  }
}

async function main() {
  const [oldDir, currentDir, option, revision, ...extra] = process.argv.slice(2)
  assert.ok(oldDir && currentDir && extra.length === 0 &&
    (option === undefined || (option === '--current-commit' && /^[a-f0-9]{40}$/.test(revision ?? ''))),
  'Usage: node scripts/test-topic-legacy-wasm.mjs OLD_PACKAGE CURRENT_PACKAGE [--current-commit FULL_SHA]')
  const currentCommit = revision ?? CURRENT_COMMIT
  const old = await loadPackage(oldDir, 'legacy', OLD_COMMIT)
  const current = await loadPackage(currentDir, 'current', currentCommit)
  assert.notEqual(old.dir, current.dir, 'packages must use different directories')
  assert.notEqual(old.wasmHash, current.wasmHash, 'packages must use different WASM binaries')
  exchange(current.module, old.module)
  console.log(JSON.stringify({ result: 'PASS: genuine mixed-version topic/ignore/snapshot/restore/text', old: { commit: OLD_COMMIT, js: old.jsHash, wasm: old.wasmHash }, current: { commit: currentCommit, js: current.jsHash, wasm: current.wasmHash } }, null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
