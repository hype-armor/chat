import { type Page, expect, test } from '@playwright/test'
import { messages, openChat, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')


test('two people exchange encrypted messages, and history survives a reload', async ({ browser }) => {
  const aliceUsername = randomUsername()
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', aliceUsername)
  const bob = await signUp(browser, 'Bob', bobUsername)

  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message').fill('Hello Bob')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice).filter({ hasText: 'Hello Bob' })).toContainText('Sent')
  // Bob's profile arrives once he joins, replacing the username.
  await expect(alice.getByRole('heading', { name: 'Bob' })).toBeVisible()

  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Hello Bob/])
  await bob.getByLabel('Message').fill('Hi Alice')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice)).toHaveText([/Hello Bob/, /Hi Alice/])

  // Keys and history are restored from encrypted storage after a reload.
  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('online')
  await bob.getByRole('button', { name: /Alice/ }).click()
  await expect(messages(bob)).toHaveText([/Hello Bob/, /Hi Alice/])
  await alice.getByLabel('Message').fill('Still there?')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(bob)).toHaveText([/Hello Bob/, /Hi Alice/, /Still there\?/])
})

test('unknown usernames are reported', async ({ browser }) => {
  const page = await signUp(browser, 'Carol', randomUsername())
  await page.getByLabel("Contact's username").fill(randomUsername())
  await page.getByRole('button', { name: 'Start chat' }).click()
  await expect(page.getByRole('alert')).toHaveText('no one has that username')
})

for (const width of [1280, 390]) {
  test(`conversation scrolling stays pinned unless reading history (${width}px)`, async ({ browser }) => {
    test.setTimeout(90_000)
    const bobUsername = randomUsername()
    const alice = await signUp(browser, 'Alice', randomUsername())
    const bob = await signUp(browser, 'Bob', bobUsername)
    await alice.setViewportSize({ width, height: 720 })
    await bob.setViewportSize({ width, height: 720 })
    const viewport = alice.locator('.messages-viewport')
    const pill = alice.getByRole('button', { name: '↓ New messages' })
    const send = async (page: Page, text: string) => {
      await page.getByLabel('Message', { exact: true }).fill(text)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(messages(page).last()).toContainText(text)
      await expect(messages(page).last()).toContainText(/Sent|Delivered|Read/)
    }
    const expectBottom = async () => {
      await expect.poll(() => viewport.evaluate(
        '(list) => list.scrollHeight - list.scrollTop - list.clientHeight',
      )).toBeLessThanOrEqual(1)
      await expect(messages(alice).last()).toBeInViewport({ ratio: 1 })
      await expect(pill).toHaveCount(0)
    }
    const scrollUp = async () => {
      await viewport.evaluate(`async (list) => {
        list.scrollTop = 0
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
      }`)
      await expect(messages(alice).first()).toBeInViewport()
    }

    await alice.getByLabel("Contact's username").fill(bobUsername)
    await alice.getByRole('button', { name: 'Start chat' }).click()
    for (let i = 0; i < 24; i++) await send(alice, `History ${i}`)
    await expect.poll(() => viewport.evaluate(
      '(list) => list.scrollHeight - list.clientHeight',
    )).toBeGreaterThan(300)
    await expectBottom()

    await openChat(bob, /Alice/)
    await send(bob, 'Arrived at the bottom')
    await expect(messages(alice).last()).toContainText('Arrived at the bottom')
    await expectBottom()

    // Delayed content growth must pin even without a new message or core event.
    await messages(alice).last().evaluate('(message) => { message.style.paddingBottom = "240px" }')
    await expectBottom()

    await scrollUp()
    const position = await viewport.evaluate('(list) => list.scrollTop')
    await send(bob, 'Arrived while reading history')
    await expect(pill).toBeVisible()
    await expect.poll(() => viewport.evaluate('(list) => list.scrollTop')).toBe(position)
    await expect(messages(alice).last()).not.toBeInViewport()
    await messages(alice).last().evaluate('(message) => { message.style.paddingBottom = "240px" }')
    await alice.evaluate('new Promise(requestAnimationFrame)')
    expect(await viewport.evaluate('(list) => list.scrollTop')).toBe(position)
    await pill.click()
    await expectBottom()

    await scrollUp()
    await send(alice, 'Sending from history')
    await expectBottom()
    await scrollUp()
    await alice.getByTestId('attach-input').setInputFiles({
      name: 'scroll.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Scroll on file send'),
    })
    await expect(messages(alice).last()).toContainText('scroll.txt')
    await expectBottom()

    // Being close to the bottom counts as pinned.
    await viewport.evaluate(`async (list) => {
      list.scrollTop = list.scrollHeight - list.clientHeight - 60
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    }`)
    await send(bob, 'Arrived near the bottom')
    await expect(messages(alice).last()).toContainText('Arrived near the bottom')
    await expectBottom()

    await scrollUp()
    await send(bob, 'Unread before switching')
    await expect(pill).toBeVisible()
    if (width <= 640) await alice.getByRole('button', { name: 'Back to conversations' }).click()
    await alice.getByText('New group', { exact: true }).click()
    await alice.getByLabel('Group name', { exact: true }).fill('Scroll reset')
    await alice.getByLabel("Members' usernames").fill(bobUsername)
    await alice.getByRole('button', { name: 'Create group' }).click()
    await expect(alice.getByRole('heading', { name: 'Scroll reset' })).toBeVisible()
    await expect(pill).toHaveCount(0)
    if (width <= 640) await alice.getByRole('button', { name: 'Back to conversations' }).click()
    await openChat(alice, /Bob/)
    await expect(messages(alice).last()).toContainText('Unread before switching')
    await expectBottom()

    await alice.reload()
    await expect(alice.getByRole('status')).toHaveText('online')
    await openChat(alice, /Bob/)
    await expect(messages(alice).last()).toContainText('Unread before switching')
    await expectBottom()
    await alice.context().close()
    await bob.context().close()
  })
}

test('groups: create, talk, and add someone later', async ({ browser }) => {
  const [annUsername, benUsername, catUsername, danUsername] = [randomUsername(), randomUsername(), randomUsername(), randomUsername()]
  const ann = await signUp(browser, 'Ann', annUsername)
  const ben = await signUp(browser, 'Ben', benUsername)
  const cat = await signUp(browser, 'Cat', catUsername)
  const dan = await signUp(browser, 'Dan', danUsername)

  await ann.getByText('New group').click()
  await ann.getByLabel('Group name').fill('Trip')
  await ann.getByLabel("Members' usernames").fill(`${benUsername}\n${catUsername}`)
  await ann.getByRole('button', { name: 'Create group' }).click()
  await expect(ann.getByRole('heading', { name: 'Trip' })).toBeVisible()
  await ann.getByLabel('Message').fill('Hi team')
  await ann.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ann).filter({ hasText: 'Hi team' })).toContainText('Sent')

  for (const page of [ben, cat]) {
    await openChat(page, /Trip/)
    await expect(messages(page)).toHaveText([/Ann\s*Hi team/])
  }
  await cat.getByLabel('Message').fill('Hello from Cat')
  await cat.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ann)).toHaveText([/Hi team/, /Cat\s*Hello from Cat/])
  await expect(messages(ben)).toHaveText([/Hi team/, /Hello from Cat/])

  // Adding Dan needs a commit the server orders; he sees only later messages.
  await ann.getByRole('button', { name: 'Add people' }).click()
  await ann.getByLabel('Usernames to add').fill(danUsername)
  await ann.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(ann.getByText('4 people')).toBeVisible()
  await dan.getByRole('button', { name: /Trip/ }).click()
  await expect(ben.getByText('4 people')).toBeVisible()
  await ben.getByLabel('Message').fill('Welcome Dan')
  await ben.getByRole('button', { name: 'Send' }).click()
  await expect(messages(dan)).toHaveText([/Ben\s*Welcome Dan/])
  for (const page of [ann, cat]) await expect(messages(page).last()).toContainText('Welcome Dan')
})

test('group admin: rename, promote, remove, and members leaving', async ({ browser }) => {
  test.setTimeout(60_000) // four sign-ups plus several server round trips
  const usernames = [randomUsername(), randomUsername(), randomUsername(), randomUsername()]
  const [ann, ben, cat, dee] = [
    await signUp(browser, 'Ann', usernames[0]),
    await signUp(browser, 'Ben', usernames[1]),
    await signUp(browser, 'Cat', usernames[2]),
    await signUp(browser, 'Dee', usernames[3]),
  ]
  await ann.getByText('New group').click()
  await ann.getByLabel('Group name').fill('Club')
  await ann.getByLabel("Members' usernames").fill(usernames.slice(1).join('\n'))
  await ann.getByRole('button', { name: 'Create group' }).click()
  await expect(ann.getByRole('heading', { name: 'Club' })).toBeVisible()
  for (const page of [ben, cat, dee]) await openChat(page, /Club/)

  // Only admins can rename.
  await ben.getByRole('button', { name: 'Group info' }).click()
  await expect(ben.getByRole('button', { name: 'Rename' })).toHaveCount(0)
  await ann.getByRole('button', { name: 'Group info' }).click()
  await ann.getByLabel('Group name', { exact: true }).last().fill('Book club')
  await ann.getByRole('button', { name: 'Rename' }).click()
  await expect(ben.getByRole('heading', { name: 'Book club' })).toBeVisible()

  // Promote Ben; he can now rename.
  await ann.getByRole('listitem').filter({ hasText: 'Ben' }).getByRole('button', { name: 'Make admin' }).click()
  await expect(ben.getByRole('button', { name: 'Rename' })).toBeVisible()

  // Remove Cat.
  await ann.getByRole('button', { name: 'Remove Cat' }).click()
  await expect(cat.getByText('You were removed from this group.')).toBeVisible()
  await expect(ann.getByText('3 people')).toBeVisible()

  // Dee leaves; Ann (first admin) commits it.
  await dee.getByRole('button', { name: 'Group info' }).click()
  await dee.getByRole('button', { name: 'Leave group' }).click()
  await expect(dee.getByText('You left this group.')).toBeVisible()
  await expect(ann.getByText('2 people')).toBeVisible()
  await expect(ben.getByText('2 people')).toBeVisible()

  // Only the remaining members get new messages.
  await ben.getByLabel('Message').fill('Just us now')
  await ben.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ann).last()).toContainText('Just us now')
  for (const page of [cat, dee]) await expect(messages(page).filter({ hasText: 'Just us now' })).toHaveCount(0)
})
