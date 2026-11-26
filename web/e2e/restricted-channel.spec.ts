import { expect, test, type Page } from './fixtures'
import { closeDetails, conversationAction, conversationDetails, createGroup, memberAction, messages, openChat, randomUsername, signUp } from './support'

test.skip(process.env.E2E_SERVER !== '1' || process.env.E2E_RESTRICTED_CHANNELS !== '1',
  'needs a disposable relay and a build with VITE_EXPERIMENTAL_RESTRICTED_CHANNELS=true')

async function channelList(page: Page) {
  await conversationAction(page, 'Group info')
  return conversationDetails(page).getByRole('region', { name: 'Private channels', exact: true })
}

async function message(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('only invited parent members can see and use a private channel', async ({ browser }) => {
  test.setTimeout(90_000)
  const [bobName, cathyName] = [randomUsername(), randomUsername()]
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobName)
  const cathy = await signUp(browser, 'Cathy', cathyName)
  await createGroup(alice, 'Parent group', [bobName, cathyName])
  await message(alice, 'Parent message')
  for (const page of [bob, cathy]) {
    // A collapsed request can include the avatar initial in its accessible name.
    await openChat(page, /Parent group/)
    await expect(page.getByRole('heading', { name: 'Parent group', exact: true })).toBeVisible()
    await expect(messages(page).filter({ hasText: 'Parent message' })).toHaveCount(1)
  }

  await (await channelList(alice)).getByRole('button', { name: 'Create private channel' }).click()
  const create = alice.getByRole('form', { name: 'Create private channel' })
  await create.getByLabel('Channel name').fill('Private planning')
  await create.getByRole('checkbox', { name: new RegExp(bobName.replace('.', '\\.')) }).check()
  await create.getByRole('button', { name: 'Create private channel' }).click()
  await expect(alice.getByRole('heading', { name: 'Private planning', exact: true })).toBeVisible()
  const bobChannels = await channelList(bob)
  await bobChannels.getByRole('button', { name: 'Private planning' }).click()
  await message(alice, 'Before Cathy joined')
  await expect(messages(bob).filter({ hasText: 'Before Cathy joined' })).toHaveCount(1)
  const cathyChannels = await channelList(cathy)
  await expect(cathyChannels.getByRole('button', { name: 'Private planning' })).toHaveCount(0)
  await expect(cathy.getByText('Private planning', { exact: true })).toHaveCount(0)

  await conversationAction(alice, 'Invite to private channel')
  const invite = alice.getByRole('form', { name: 'Invite to private channel' })
  await invite.getByRole('checkbox', { name: new RegExp(cathyName.replace('.', '\\.')) }).check()
  await invite.getByRole('button', { name: 'Invite members' }).click()
  await cathyChannels.getByRole('button', { name: 'Private planning' }).click()
  await expect(cathy.getByRole('heading', { name: 'Private planning', exact: true })).toBeVisible()
  await message(cathy, 'After Cathy joined')
  for (const page of [alice, bob]) await expect(messages(page).filter({ hasText: 'After Cathy joined' })).toHaveCount(1)
  await message(bob, 'Welcome, Cathy')
  await expect(messages(cathy).filter({ hasText: 'Welcome, Cathy' })).toHaveCount(1)
  await expect(messages(cathy).filter({ hasText: 'Before Cathy joined' })).toHaveCount(0)
})

test('parent removal repairs the private channel without readmitting the removed member', async ({ browser }) => {
  test.setTimeout(120_000)
  const [bobName, cathyName, danName] = [randomUsername(), randomUsername(), randomUsername()]
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobName)
  const cathy = await signUp(browser, 'Cathy', cathyName)
  const dan = await signUp(browser, 'Dan', danName)
  await createGroup(alice, 'Repair parent', [bobName, cathyName, danName])
  await message(alice, 'Parent ready')
  for (const page of [bob, cathy, dan]) {
    await openChat(page, /Repair parent/)
    await expect(messages(page).filter({ hasText: 'Parent ready' })).toHaveCount(1)
  }

  await (await channelList(alice)).getByRole('button', { name: 'Create private channel' }).click()
  const create = alice.getByRole('form', { name: 'Create private channel' })
  await create.getByLabel('Channel name').fill('Repair channel')
  for (const username of [bobName, cathyName]) {
    await create.getByRole('checkbox', { name: new RegExp(username.replace('.', '\\.')) }).check()
  }
  await create.getByRole('button', { name: 'Create private channel' }).click()
  await expect(alice.getByRole('heading', { name: 'Repair channel', exact: true })).toBeVisible()
  for (const page of [bob, cathy]) {
    await (await channelList(page)).getByRole('button', { name: 'Repair channel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Repair channel', exact: true })).toBeVisible()
  }
  await message(bob, 'Before removal')
  for (const page of [alice, cathy]) {
    await expect(messages(page).filter({ hasText: 'Before removal' })).toHaveCount(1)
  }
  const danChannels = await channelList(dan)
  await expect(danChannels.getByRole('button', { name: 'Repair channel', exact: true })).toHaveCount(0)
  await expect(dan.getByText('Repair channel', { exact: true })).toHaveCount(0)

  // Disconnect Bob's real worker. His persisted channel state must not authorize
  // sends or reveal later text when he next opens the app.
  await bob.goto('about:blank')
  await conversationAction(alice, 'Group info')
  await conversationDetails(alice).getByRole('button', { name: 'Repair parent', exact: true }).click()
  await conversationAction(alice, 'Group info')
  await memberAction(alice, 'Bob', 'Remove')
  await expect(alice.locator('.conversation-title')).toContainText('3 people')
  await conversationDetails(alice).getByRole('region', { name: 'Private channels', exact: true })
    .getByRole('button', { name: 'Repair channel', exact: true }).click()

  // Poll the real composer and peer delivery, not a local optimistic message.
  // Both remaining members must resume sends after the child MLS repair.
  for (const page of [alice, cathy]) {
    await closeDetails(page)
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({ timeout: 30_000 })
  }
  await message(alice, 'Creator after repair')
  await expect(messages(cathy).filter({ hasText: 'Creator after repair' })).toHaveCount(1, { timeout: 30_000 })
  await message(cathy, 'Member after repair')
  await expect(messages(alice).filter({ hasText: 'Member after repair' })).toHaveCount(1, { timeout: 30_000 })

  await bob.goto('/')
  await expect(bob.getByRole('status', { name: 'Connection status' })).toHaveText('Connected', { timeout: 30_000 })
  // Do not use openChat: its helper requires a writable composer.
  await bob.getByRole('button', { name: /Repair parent/ }).click()
  await expect(bob.getByText('You were removed from this group.')).toBeVisible({ timeout: 30_000 })
  await (await channelList(bob)).getByRole('button', { name: 'Repair channel', exact: true }).click()
  await closeDetails(bob)
  await expect(bob.getByRole('textbox', { name: 'Message', exact: true })).toBeHidden()
  for (const text of ['Creator after repair', 'Member after repair']) {
    await expect(messages(bob).filter({ hasText: text })).toHaveCount(0)
  }

  // Rejoining the parent does not constitute a new private-channel invitation.
  await conversationAction(alice, 'Group info')
  await conversationDetails(alice).getByRole('button', { name: 'Repair parent', exact: true }).click()
  await conversationAction(alice, 'Add people')
  await alice.getByLabel('Usernames to add').fill(bobName)
  await alice.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(alice.locator('.conversation-title')).toContainText('4 people')
  // The retained client's parent MLS roster now includes Bob again. An old
  // inactive parent MLS instance on Bob's device can ignore a rejoin Welcome.
  // Do not require a writable parent there to verify the child transport.

  await (await channelList(alice)).getByRole('button', { name: 'Repair channel', exact: true }).click()
  await expect(alice.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({ timeout: 30_000 })
  await message(alice, 'Still private after parent rejoin')
  await expect(messages(cathy).filter({ hasText: 'Still private after parent rejoin' })).toHaveCount(1, { timeout: 30_000 })
  for (const text of ['Creator after repair', 'Member after repair', 'Still private after parent rejoin']) {
    await expect(messages(bob).filter({ hasText: text })).toHaveCount(0)
  }
  await expect(bob.getByRole('textbox', { name: 'Message', exact: true })).toBeHidden()
  await expect(danChannels.getByRole('button', { name: 'Repair channel', exact: true })).toHaveCount(0)
  await expect(dan.getByText('Repair channel', { exact: true })).toHaveCount(0)
})
