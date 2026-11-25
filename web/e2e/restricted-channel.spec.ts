import { expect, test, type Page } from './fixtures'
import { conversationAction, conversationDetails, createGroup, messages, openChat, randomUsername, signUp } from './support'

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
    await openChat(page, /^Parent group/)
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
