import { expect, test } from './fixtures'
type Fixture = { openError: string; deliver(fail: boolean): Promise<void>; read(): Promise<unknown>; open(): Promise<void>; race(): Promise<boolean[]> }
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/delivery-journal-fixture.html')
  await page.waitForFunction(() => !!(window as unknown as { journalFixture?: unknown }).journalFixture)
})
test('commits staged records before publication and fences reload after a failure', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { journalFixture: Fixture }).journalFixture
    let error = ''; try { await f.deliver(true) } catch (e) { error = String(e) }
    return { error, state: await f.read() }
  })
  expect(result.error).toContain('publication failed')
  expect(result.state).toEqual({ revision: 1, core: [1], app: { messages: ['1'] }, seen: 1, pending: 'one' })
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { journalFixture?: unknown }).journalFixture)
  expect(await page.evaluate(() => (window as unknown as { journalFixture: Fixture }).journalFixture.openError)).toContain('manual recovery')
})
test('IndexedDB compare and replace serializes competing instances', async ({ page }) => {
  const result = await page.evaluate(() => (window as unknown as { journalFixture: Fixture }).journalFixture.race())
  expect(result.filter(Boolean)).toHaveLength(1)
})
