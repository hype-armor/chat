import { expect, test } from '@playwright/test'
import { randomPhone, signUp, verificationCode } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('a device tops its key packages back up when others use them (roadmap 14)', async ({ browser, request }) => {
  const bobPhone = randomPhone()
  const bob = await signUp(browser, 'Bob', bobPhone)

  // A second account, driven through the API, uses up Bob's key packages.
  const phone = randomPhone()
  await request.post('/v1/auth/request-code', { data: { phone } })
  const verified = await request.post('/v1/auth/verify', {
    data: { phone, code: await verificationCode(phone), identity_key: 'a2V5' },
  })
  const { token } = await verified.json()
  const auth = { authorization: `Bearer ${token}` }
  const found = await (await request.post('/v1/lookup', { headers: auth, data: { phone: bobPhone } })).json()
  const claim = async () => {
    const res = await request.post('/v1/keys/claim', { headers: auth, data: { device_ids: found.device_ids } })
    return Object.keys((await res.json()).key_packages).length === 1
  }
  for (let i = 0; i < 20; i++) expect(await claim()).toBe(true)
  expect(await claim(), 'all used up').toBe(false)

  // Bob's app reconnects, learns none are left and uploads a fresh batch.
  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('online')
  await expect.poll(claim, { timeout: 10_000 }).toBe(true)
  for (let i = 0; i < 19; i++) expect(await claim(), `claim ${i + 2} of 20`).toBe(true)
})
