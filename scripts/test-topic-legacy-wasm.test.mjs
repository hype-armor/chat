import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { OLD_COMMIT, loadPackage, exchange } from './test-topic-legacy-wasm.mjs'

test('an explicit current commit pin requires a full SHA', () => {
  const script = fileURLToPath(new URL('./test-topic-legacy-wasm.mjs', import.meta.url))
  for (const revision of [[], ['4e018ad'], ['a'.repeat(40), 'unexpected']]) {
    const result = spawnSync(process.execPath, [script, 'legacy', 'current', '--current-commit', ...revision],
      { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:/)
  }
})

// Invalid fixtures test input rejection only. They never simulate an old client.
test('reject unproven or modified artifacts before loading JS/WASM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'topic-input-test-'))
  const hash = value => createHash('sha256').update(value).digest('hex')
  try {
    await writeFile(join(dir, 'chat_core.js'), 'throw new Error("must not execute")')
    await writeFile(join(dir, 'chat_core_bg.wasm'), 'invalid WASM')
    await assert.rejects(loadPackage(dir, 'invalid', OLD_COMMIT), /ENOENT/)
    const manifest = { sourceCommit: 'wrong', jsSha256: hash('wrong'), wasmSha256: hash('wrong') }
    const save = () => writeFile(join(dir, 'topic-compat-build.json'), JSON.stringify(manifest))
    await save()
    await assert.rejects(loadPackage(dir, 'invalid', OLD_COMMIT), /wrong source commit/)
    manifest.sourceCommit = OLD_COMMIT
    await save()
    await assert.rejects(loadPackage(dir, 'invalid', OLD_COMMIT), /JS checksum mismatch/)
    manifest.jsSha256 = hash('throw new Error("must not execute")')
    await save()
    await assert.rejects(loadPackage(dir, 'invalid', OLD_COMMIT), /WASM checksum mismatch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('existing current bindings: isolated instances and durable ratchet smoke, NOT legacy evidence', {
  skip: !process.env.CURRENT_WASM_PACKAGE && 'Set CURRENT_WASM_PACKAGE to explicit existing bindings; no build occurs',
}, async () => {
  const a = await loadPackage(process.env.CURRENT_WASM_PACKAGE, 'current-smoke-a')
  const b = await loadPackage(process.env.CURRENT_WASM_PACKAGE, 'current-smoke-b')
  exchange(a.module, b.module, false)
  assert.throws(() => exchange(a.module, b.module), /old package must predate topics/)
})
