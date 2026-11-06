import { expect, test } from './fixtures'
import { randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('a device tops its key packages back up when others use them (roadmap 14)', async ({ browser, request }) => {
  const bobUsername = randomUsername()
  const bob = await signUp(browser, 'Bob', bobUsername)

  // Distinct callers use up Bob's packages without exceeding three leases
  // per caller. They each hold one more lease after the replenishment.
  const callers: { authorization: string }[] = []
  for (let i = 0; i < 20; i++) {
    const username = randomUsername()
    const verified = await request.post('/v1/register', { data: { username, identity_key: 'a2V5' } })
    expect(verified.ok()).toBe(true)
    const { token } = await verified.json()
  const auth = { authorization: `Bearer ${token}` }
    callers.push(auth)
  }
  const found = await (await request.post('/v1/lookup', { headers: callers[0], data: { username: bobUsername } })).json()
  const claim = async (auth: { authorization: string }) => {
    const res = await request.post('/v1/keys/claim', { headers: auth, data: { device_ids: found.device_ids } })
    expect(res.ok()).toBe(true)
    return Object.keys((await res.json()).key_packages).length === 1
  }
  for (const auth of callers) expect(await claim(auth)).toBe(true)
  expect(await claim(callers[0]), 'all used up').toBe(false)

  // Bob's app reconnects, learns none are left and uploads a fresh batch.
  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('Connected')
  await expect.poll(() => claim(callers[0]), { timeout: 10_000 }).toBe(true)
  for (const auth of callers.slice(1)) expect(await claim(auth)).toBe(true)
  expect(await claim(callers[0]), 'fresh batch used up').toBe(false)
  await bob.context().close()
})
