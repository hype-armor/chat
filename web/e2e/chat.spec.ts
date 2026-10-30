import { type Page, expect, test } from '@playwright/test'
import { conversationAction, createGroup, messages, openChat, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')


test('two people exchange encrypted messages, and history survives a reload', async ({ browser }) => {
  const aliceUsername = randomUsername()
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', aliceUsername)
  const bob = await signUp(browser, 'Bob', bobUsername)

  await startChat(alice, bobUsername)
  await alice.getByLabel('Message').fill('Hello Bob')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice).filter({ hasText: 'Hello Bob' }).getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
  // Bob's profile arrives once he joins, replacing the username.
  await expect(alice.getByRole('heading', { name: 'Bob' })).toBeVisible()

  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Hello Bob/])
  await bob.getByLabel('Message').fill('Hi Alice')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice)).toHaveText([/Hello Bob/, /Hi Alice/])

  // Keys and history are restored from encrypted storage after a reload.
  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('Connected')
  await bob.getByRole('button', { name: /Alice/ }).click()
  await expect(messages(bob)).toHaveText([/Hello Bob/, /Hi Alice/])
  await alice.getByLabel('Message').fill('Still there?')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(bob)).toHaveText([/Hello Bob/, /Hi Alice/, /Still there\?/])
})

test('unknown usernames are reported', async ({ browser }) => {
  const page = await signUp(browser, 'Carol', randomUsername())
  await startChat(page, randomUsername())
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
      // By its text: a message from the other side (e.g. a file still
      // uploading when this one was sent) may arrive after it.
      const sent = messages(page).filter({ hasText: text }).last()
      await expect(sent).toBeVisible()
      await expect(sent.getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
    }
    const expectBottom = async () => {
      await expect.poll(() => viewport.evaluate(
        (list) => list.scrollHeight - list.scrollTop - list.clientHeight,
      )).toBeLessThanOrEqual(1)
      await expect(messages(alice).last()).toBeInViewport({ ratio: 1 })
      await expect(pill).toHaveCount(0)
    }
    const scrollUp = async () => {
      await viewport.evaluate((list) => { list.scrollTop = 0 })
      await alice.evaluate('new Promise(requestAnimationFrame)')
      await alice.evaluate('new Promise(requestAnimationFrame)')
      await expect(messages(alice).first()).toBeInViewport()
    }

    await startChat(alice, bobUsername)
    for (let i = 0; i < 24; i++) await send(alice, `History ${i}`)
    await expect.poll(() => viewport.evaluate(
      (list) => list.scrollHeight - list.clientHeight,
    )).toBeGreaterThan(300)
    await expectBottom()

    await openChat(bob, /Alice/)
    await send(bob, 'Arrived at the bottom')
    await expect(messages(alice).last()).toContainText('Arrived at the bottom')
    await expectBottom()

    // Delayed content growth must pin even without a new message or core event.
    await messages(alice).last().evaluate((message) => { message.style.paddingBottom = '240px' })
    await expectBottom()

    // A resize before the user's queued scroll event must not pull them back down.
    await alice.evaluate(`(() => {
      document.querySelector('.messages-viewport').scrollTop = 0
      document.querySelector('.messages li:last-child').style.paddingBottom = '280px'
    })()`)
    await expect(messages(alice).first()).toBeInViewport()
    const position = await viewport.evaluate((list) => list.scrollTop)
    await send(bob, 'Arrived while reading history')
    await expect(pill).toBeVisible()
    await expect.poll(() => viewport.evaluate((list) => list.scrollTop)).toBe(position)
    await expect(messages(alice).last()).not.toBeInViewport()
    await messages(alice).last().evaluate((message) => { message.style.paddingBottom = '240px' })
    await alice.evaluate('new Promise(requestAnimationFrame)')
    expect(await viewport.evaluate((list) => list.scrollTop)).toBe(position)
    await pill.click()
    await expectBottom()

    await scrollUp()
    await send(bob, 'Growth during a pending scroll')
    await expect(pill).toBeVisible()
    await alice.evaluate(`(() => {
      document.querySelector('.new-messages button').click()
      document.querySelector('.messages li:last-child').style.paddingBottom = '320px'
    })()`)
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
    await viewport.evaluate((list) => {
      list.scrollTop = list.scrollHeight - list.clientHeight - 60
    })
    await alice.evaluate('new Promise(requestAnimationFrame)')
    await alice.evaluate('new Promise(requestAnimationFrame)')
    await send(bob, 'Arrived near the bottom')
    await expect(messages(alice).last()).toContainText('Arrived near the bottom')
    await expectBottom()

    await scrollUp()
    await send(bob, 'Unread before switching')
    await expect(pill).toBeVisible()
    if (width <= 640) await alice.getByRole('button', { name: 'Back to conversations' }).click()
    await createGroup(alice, 'Scroll reset', [bobUsername])
    await expect(alice.getByRole('heading', { name: 'Scroll reset' })).toBeVisible()
    await expect(pill).toHaveCount(0)
    if (width <= 640) await alice.getByRole('button', { name: 'Back to conversations' }).click()
    await openChat(alice, /Bob/)
    await expect(messages(alice).last()).toContainText('Unread before switching')
    await expectBottom()

    await alice.reload()
    await expect(alice.getByRole('status')).toHaveText('Connected')
    await openChat(alice, /Bob/)
    await expect(messages(alice).last()).toContainText('Unread before switching')
    await expectBottom()
    await alice.context().close()
    await bob.context().close()
  })
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`message runs keep accessible metadata (${colorScheme}, ${width}px)`, async ({ browser }) => {
      const bobUsername = randomUsername()
      const alice = await signUp(browser, 'Alice', randomUsername())
      const bob = await signUp(browser, 'Bob', bobUsername)
      for (const page of [alice, bob]) {
        await page.setViewportSize({ width, height: 720 })
        await page.emulateMedia({ colorScheme })
      }
      await alice.getByText('New group', { exact: true }).click()
      await alice.getByLabel('Group name', { exact: true }).fill('Message polish')
      await alice.getByLabel("Members' usernames").fill(bobUsername)
      await alice.getByRole('button', { name: 'Create group' }).click()
      await openChat(bob, /Message polish/)
      for (const text of ['First in run', 'Last in run']) {
        await alice.getByLabel('Message', { exact: true }).fill(text)
        await alice.getByRole('button', { name: 'Send', exact: true }).click()
        await expect(messages(bob).filter({ hasText: text })).toBeVisible()
      }

      for (const page of [alice, bob]) {
        const bubbles = messages(page)
        await expect(bubbles).toHaveCount(2)
        await expect(page.getByRole('separator', { name: 'Today' })).toHaveCount(1)
        await expect(page.getByRole('separator')).not.toHaveAttribute('data-testid', 'message')
        await expect(bubbles.first()).toHaveClass(/run-first/)
        await expect(bubbles.first()).not.toHaveClass(/run-last/)
        await expect(bubbles.last()).not.toHaveClass(/run-first/)
        await expect(bubbles.last()).toHaveClass(/run-last/)
        await expect(bubbles.locator('time:not(.visually-hidden)')).toHaveCount(1)
        const sender = page === alice ? 'You' : 'Alice'
        for (const bubble of await bubbles.all()) {
          expect(await bubble.ariaSnapshot()).toContain(sender)
          await expect(bubble.locator('time')).toHaveAttribute('datetime', /T/)
          await expect(bubble.locator('time')).toHaveAttribute('aria-label', /\d/)
          await expect(bubble).toHaveAttribute('title', /\d/)
          await expect(bubble.getByRole('img')).toHaveAccessibleName(
            page === alice ? /^(Sent|Delivered|Read)$/ : 'Received',
          )
        }
        // Joined bubbles stay inside the viewport, including on mobile.
        const bounds = await bubbles.last().boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        await expect(bubbles.last()).toBeInViewport({ ratio: 1 })
      }
      await expect(messages(bob).locator('.sender')).toHaveCount(1)
      await expect(messages(bob).first().locator('.sender')).toHaveText('Alice')
      await expect(messages(alice).locator('.message-status')).toHaveCount(1)
      await expect(messages(alice).last().locator('.message-status')).toBeVisible()
      await expect(messages(bob).locator('.message-status')).toHaveCount(0)
      await alice.context().close()
      await bob.context().close()
    })
  }
}

test('groups: create, talk, and add someone later', async ({ browser }) => {
  const [annUsername, benUsername, catUsername, danUsername] = [randomUsername(), randomUsername(), randomUsername(), randomUsername()]
  const ann = await signUp(browser, 'Ann', annUsername)
  const ben = await signUp(browser, 'Ben', benUsername)
  const cat = await signUp(browser, 'Cat', catUsername)
  const dan = await signUp(browser, 'Dan', danUsername)

  await createGroup(ann, 'Trip', [benUsername, catUsername])
  await expect(ann.getByRole('heading', { name: 'Trip' })).toBeVisible()
  await ann.getByLabel('Message').fill('Hi team')
  await ann.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ann).filter({ hasText: 'Hi team' }).getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()

  for (const page of [ben, cat]) {
    await openChat(page, /Trip/)
    await expect(messages(page)).toHaveText([/Ann\s*Hi team/])
  }
  await cat.getByLabel('Message').fill('Hello from Cat')
  await cat.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ann)).toHaveText([/Hi team/, /Cat\s*Hello from Cat/])
  await expect(messages(ben)).toHaveText([/Hi team/, /Hello from Cat/])

  // Adding Dan needs a commit the server orders; he sees only later messages.
  await conversationAction(ann, 'Add people')
  await ann.getByLabel('Usernames to add').fill(danUsername)
  await ann.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(ann.getByText('4 people')).toBeVisible()
  await openChat(dan, /Trip/)
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
  await createGroup(ann, 'Club', usernames.slice(1))
  await expect(ann.getByRole('heading', { name: 'Club' })).toBeVisible()
  for (const page of [ben, cat, dee]) await openChat(page, /Club/)

  // Only admins can rename.
  await conversationAction(ben, 'Group info')
  await expect(ben.getByRole('button', { name: 'Rename' })).toHaveCount(0)
  await conversationAction(ann, 'Group info')
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
  await conversationAction(dee, 'Group info')
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
