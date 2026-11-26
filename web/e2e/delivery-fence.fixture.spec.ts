import { expect, test } from './fixtures'

type Fixture = {
  open(): Promise<void>; deliver(): Promise<void>; read(): Promise<{ revision: number; core: number[]; seen: string[]; pending: string | null }>
  fail(call: number, mode: 'abort' | 'after-commit'): void
  counts(): { acknowledgements: number; effects: number }; allowed(): void
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/delivery-fence-fixture.html')
  await page.waitForFunction(() => !!(window as unknown as { deliveryFixture?: unknown }).deliveryFixture)
})

for (const [call, mode, expected, effects] of [
  [1, 'abort', { revision: 0, core: [0], seen: [], pending: null }, 0],
  [1, 'after-commit', { revision: 1, core: [0], seen: [], pending: 'one' }, 0],
  [2, 'abort', { revision: 1, core: [0], seen: [], pending: 'one' }, 1],
  [2, 'after-commit', { revision: 2, core: [1], seen: ['one'], pending: null }, 1],
] as const) {
  test(`write ${call}: ${mode} retains an atomic state across reload`, async ({ page }) => {
    const result = await page.evaluate(async ({ call, mode }) => {
      const f = (window as unknown as { deliveryFixture: Fixture }).deliveryFixture
      await f.open(); f.fail(call, mode)
      let error = '', fenced = false
      try { await f.deliver() } catch (e) { error = String(e) }
      try { f.allowed() } catch { fenced = true }
      return { error, fenced, counts: f.counts(), state: await f.read() }
    }, { call, mode })
    expect(result.error).toContain(mode === 'abort' ? 'aborted' : 'uncertain')
    expect(result.fenced).toBe(true)
    expect(result.counts).toEqual({ acknowledgements: 0, effects })
    expect(result.state).toEqual(expected)
    await page.reload()
    await page.waitForFunction(() => !!(window as unknown as { deliveryFixture?: unknown }).deliveryFixture)
    const after = await page.evaluate(async () => {
      const f = (window as unknown as { deliveryFixture: Fixture }).deliveryFixture
      const state = await f.read()
      try { await f.open(); return { state, reopen: 'open' } } catch (e) { return { state, reopen: String(e) } }
    })
    expect(after.state).toEqual(expected)
    expect(after.reopen).toContain(expected.pending ? 'manual recovery' : 'open')
    if (!expected.pending) {
      const delivered = await page.evaluate(async () => {
        const f = (window as unknown as { deliveryFixture: Fixture }).deliveryFixture
        await f.deliver()
        return { counts: f.counts(), state: await f.read() }
      })
      expect(delivered.counts).toEqual({ acknowledgements: 1, effects: call === 2 ? 0 : 1 })
      expect(delivered.state).toEqual({ revision: call === 2 ? 4 : 2, core: [1], seen: ['one'], pending: null })
    }
  })
}
