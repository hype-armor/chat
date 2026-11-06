import { type Page } from '@playwright/test'

/** Test-only counters. Start before the UI creates its observers and callbacks. */
export async function trackLayoutActivity(page: Page) {
  const activity = await page.evaluateHandle(() => {
    const counts = { resize: 0, frames: 0, mutations: 0 }
    const ResizeObserver = window.ResizeObserver
    const requestAnimationFrame = window.requestAnimationFrame
    window.ResizeObserver = class extends ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          counts.resize++
          callback(entries, observer)
        })
      }
    }
    window.requestAnimationFrame = (callback) => requestAnimationFrame.call(window, (time) => {
      counts.frames++
      callback(time)
    })
    const mutations = new MutationObserver(() => counts.mutations++)
    mutations.observe(document.documentElement, {
      attributes: true, childList: true, subtree: true, characterData: true,
    })
    return {
      counts,
      stop() {
        mutations.disconnect()
        window.ResizeObserver = ResizeObserver
        window.requestAnimationFrame = requestAnimationFrame
      },
    }
  })
  return {
    // Sample app activity, not a synthetic frame loop. The caller polls for a
    // quiet window so delayed fonts, transitions and slower CI can settle.
    sample: () => activity.evaluate(async ({ counts }) => {
      const before = { ...counts }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return {
        resize: counts.resize - before.resize,
        frames: counts.frames - before.frames,
        mutations: counts.mutations - before.mutations,
      }
    }),
    async dispose() {
      try {
        await activity.evaluate((tracker) => tracker.stop())
      } finally {
        await activity.dispose()
      }
    },
  }
}
