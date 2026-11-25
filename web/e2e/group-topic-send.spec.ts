import { expect, test, type Page } from './fixtures'
import { conversationAction, conversationDetails, createGroup, messages, openChat, randomUsername, signUp } from './support'

test.skip(process.env.E2E_SERVER !== '1' || process.env.E2E_GROUP_TOPICS !== '1',
  'needs a disposable chat-server and a web build with VITE_EXPERIMENTAL_GROUP_TOPICS=true')

async function groupTopic(page: Page) {
  await conversationAction(page, 'Group info')
  return conversationDetails(page).getByRole('region', { name: 'Group topic', exact: true })
}

async function editTopic(page: Page, text: string) {
  const topic = await groupTopic(page)
  await topic.getByRole('button', { name: 'Edit topic', exact: true }).click()
  await topic.getByRole('textbox', { name: 'Group topic', exact: true }).fill(text)
  await topic.getByRole('button', { name: 'Queue topic update', exact: true }).click()
  await expect(topic.getByText(/Topic update queued\./)).toBeVisible()
}

test('private group members receive, retain and clear an encrypted topic', async ({ browser }) => {
  test.setTimeout(90_000)
  const [benName, catName] = [randomUsername(), randomUsername()]
  const ann = await signUp(browser, 'Ann', randomUsername())
  const ben = await signUp(browser, 'Ben', benName)
  const cat = await signUp(browser, 'Cat', catName)
  await createGroup(ann, 'Topic test', [benName, catName])
  await ann.getByLabel('Message', { exact: true }).fill('Hello group')
  await ann.getByRole('button', { name: 'Send', exact: true }).click()
  for (const page of [ben, cat]) {
    await openChat(page, /Topic test/)
    await expect(page.getByRole('heading', { name: 'Topic test', exact: true })).toBeVisible()
    await expect(messages(page).filter({ hasText: 'Hello group' })).toHaveCount(1)
  }

  const text = 'Meet at the library'
  await editTopic(ann, text)
  for (const page of [ben, cat]) {
    const topic = await groupTopic(page)
    await expect(topic.getByText(text, { exact: true })).toBeVisible()
    await expect(messages(page)).toHaveCount(1)
  }

  await ben.reload()
  await openChat(ben, /Topic test/)
  await expect((await groupTopic(ben)).getByText(text, { exact: true })).toBeVisible()
  await editTopic(ben, '')
  for (const page of [ann, cat]) {
    await expect(conversationDetails(page).getByText('No topic.', { exact: true })).toBeVisible()
    await expect(messages(page)).toHaveCount(1)
  }
})
