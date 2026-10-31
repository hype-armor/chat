import { expect, test } from '@playwright/test'
import { messages, openChat, openSetting, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('restoring a backup on a wiped browser; contacts add the device back (ADR-0022)', async ({ browser }) => {
  test.setTimeout(60_000)
  const aliceUsername = randomUsername()
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', aliceUsername)
  const bob = await signUp(browser, 'Bob', bobUsername)
  await startChat(alice, bobUsername)
  await alice.getByLabel('Message', { exact: true }).fill('Before the backup')
  await alice.getByRole('button', { name: 'Send' }).click()
  await openChat(bob, /Alice/)
  await bob.getByLabel('Message', { exact: true }).fill('Got it')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice)).toHaveText([/Before the backup/, /Got it/])

  // Alice turns on backup and notes her recovery key.
  await openSetting(alice, 'Backup')
  await alice.getByRole('button', { name: 'Turn on backup' }).click()
  const recoveryKey = (await alice.getByTestId('recovery-key').textContent())!.trim()
  expect(recoveryKey).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/)
  await alice.getByLabel("I've stored my recovery key somewhere safe").check()
  await alice.getByRole('button', { name: 'Done' }).click()
  await expect(alice.getByTestId('backup-status')).toContainText('Last backup')
  const backup = await openSetting(alice, 'Backup')
  await expect(backup.locator('summary')).toContainText('Last backup:')
  const turnOff = backup.getByRole('button', { name: 'Turn off backup' })
  for (const colorScheme of ['light', 'dark'] as const) {
    await alice.emulateMedia({ colorScheme })
    await expect(turnOff).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(turnOff).toHaveCSS('color', colorScheme === 'light' ? 'rgb(207, 34, 46)' : 'rgb(248, 81, 73)')
  }

  // Her browser is wiped; she restores in a fresh one.
  await alice.context().close()
  const restored = await (await browser.newContext()).newPage()
  await restored.goto('/')
  await restored.getByRole('button', { name: /Restore from backup/ }).click()
  await restored.getByLabel('Username').fill(aliceUsername)
  await restored.getByLabel('Recovery key').fill(recoveryKey.toLowerCase())
  await restored.getByRole('button', { name: 'Restore' }).click()
  await expect(restored.getByRole('status')).toHaveText('Connected')
  await expect(restored.locator('header strong')).toHaveText('Alice')

  // History is back; Bob's app adds the new device and messages flow again.
  await restored.getByRole('button', { name: /Bob/ }).click()
  await expect(messages(restored)).toHaveText([/Before the backup/, /Got it/])
  await expect(restored.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(bob.getByTestId('notice')).toContainText("Alice's safety number changed")
  await bob.getByLabel('Message', { exact: true }).fill('Welcome back')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(messages(restored)).toHaveText([/Before the backup/, /Got it/, /Welcome back/])
  await restored.getByLabel('Message', { exact: true }).fill('Thanks!')
  await restored.getByRole('button', { name: 'Send' }).click()
  await expect(messages(bob).filter({ hasText: 'Thanks!' })).toBeVisible()
})
