import { writeFile } from 'node:fs/promises'
import { type Page, type TestInfo } from '@playwright/test'

type ComposerObservation = {
  inputPresent: boolean
  inputReplaced: boolean
  draftMatchesExpected: boolean
  draftLength: number
  formHidden: boolean | 'until-found' | null
  formWidth: number
  formHeight: number
  sendPresent: boolean
  sendHiddenAncestor: boolean
  sendWidth: number
  sendHeight: number
  sendVisibility: string | null
  appHeight: string
  viewportHeight: number | null
  innerHeight: number
  pageVisibility: string
  expectedMessagePresent: boolean
}

/** Synthetic safety-test diagnostics only. Never retain text, account IDs, or keys. */
export async function observeSafetyComposer(page: Page, expected: string, sender: string, info: TestInfo) {
  const observations: ComposerObservation[] = []
  await page.exposeFunction('__observeSafetyComposer', (state: ComposerObservation) => {
    if (JSON.stringify(observations.at(-1)) === JSON.stringify(state)) return
    observations.push(state)
    if (observations.length > 30) observations.shift()
  })
  await page.evaluate((expected) => {
    type Scope = Window & {
      __observeSafetyComposer: (state: ComposerObservation) => Promise<void>
      __stopSafetyComposer?: () => void
    }
    const scope = window as unknown as Scope
    let initialInput: HTMLTextAreaElement | undefined
    const report = () => {
      const input = document.querySelector<HTMLTextAreaElement>('.composer textarea')
      if (input && !initialInput) initialInput = input
      const form = input?.closest('form')
      const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]')
      const formBounds = form?.getBoundingClientRect()
      const buttonBounds = button?.getBoundingClientRect()
      void scope.__observeSafetyComposer({
        inputPresent: !!input,
        inputReplaced: !!initialInput && initialInput !== input,
        draftMatchesExpected: input?.value === expected,
        draftLength: input?.value.length ?? 0,
        formHidden: form?.hidden ?? null,
        formWidth: formBounds?.width ?? 0,
        formHeight: formBounds?.height ?? 0,
        sendPresent: !!button,
        sendHiddenAncestor: !!button?.closest('[hidden]'),
        sendWidth: buttonBounds?.width ?? 0,
        sendHeight: buttonBounds?.height ?? 0,
        sendVisibility: button ? getComputedStyle(button).visibility : null,
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        viewportHeight: visualViewport?.height ?? null,
        innerHeight,
        pageVisibility: document.visibilityState,
        expectedMessagePresent: [...document.querySelectorAll('[data-testid="message"]')].some((message) => message.textContent?.includes(expected)),
      }).catch(() => {})
    }
    // Observe native APIs. Do not patch them or change the application's layout.
    const mutations = new MutationObserver(report)
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'style'] })
    const resize = new ResizeObserver(report)
    resize.observe(document.documentElement)
    const form = document.querySelector('.composer')
    if (form) resize.observe(form)
    document.addEventListener('input', report, true)
    document.addEventListener('visibilitychange', report)
    visualViewport?.addEventListener('resize', report)
    scope.__stopSafetyComposer = () => {
      mutations.disconnect()
      resize.disconnect()
      document.removeEventListener('input', report, true)
      document.removeEventListener('visibilitychange', report)
      visualViewport?.removeEventListener('resize', report)
      delete scope.__stopSafetyComposer
    }
    report()
  }, expected)
  return {
    latest: () => observations.at(-1),
    attach: async () => {
      // Write a file too: CI uploads test-results, not an inline JSON reporter.
      const path = info.outputPath(`safety-composer-${sender}.json`)
      await writeFile(path, JSON.stringify(observations, null, 2))
      await info.attach(`safety-composer-${sender}`, { contentType: 'application/json', path })
    },
    stop: () => page.evaluate(() => {
      (window as Window & { __stopSafetyComposer?: () => void }).__stopSafetyComposer?.()
    }).catch(() => {}),
  }
}
