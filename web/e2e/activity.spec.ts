import { expect, test } from './fixtures'
import { trackLayoutActivity } from './activity'

for (const signal of ['resize', 'frames', 'mutations'] as const) {
  test(`layout diagnostics detect ${signal} activity and settle after it stops`, async ({ page }) => {
    await page.setContent('<div style="width: 10px; height: 10px"></div>')
    const originals = await page.evaluateHandle(() => ({
      ResizeObserver: window.ResizeObserver,
      requestAnimationFrame: window.requestAnimationFrame,
    }))
    const activity = await trackLayoutActivity(page)
    const loop = await page.evaluateHandle((signal) => {
      const element = document.querySelector('div')!
      let frame = 0
      let counter = 0
      const change = () => {
        element.style.width = `${10 + (++counter % 2)}px`
      }
      const observer = signal === 'resize' ? new ResizeObserver(() => change()) : null
      observer?.observe(element)
      const tick = () => {
        if (signal === 'mutations') element.textContent = String(++counter)
        frame = requestAnimationFrame(tick)
      }
      if (!observer) tick()
      return () => {
        observer?.disconnect()
        cancelAnimationFrame(frame)
      }
    }, signal)
    try {
      expect((await activity.sample())[signal]).toBeGreaterThan(0)
      await loop.evaluate((stop) => stop())
      await expect.poll(activity.sample, { timeout: 10_000 }).toEqual({ resize: 0, frames: 0, mutations: 0 })
    } finally {
      await loop.evaluate((stop) => stop())
      await loop.dispose()
      await activity.dispose()
    }
    expect(await originals.evaluate((originals) =>
      window.ResizeObserver === originals.ResizeObserver
      && window.requestAnimationFrame === originals.requestAnimationFrame,
    )).toBe(true)
    await originals.dispose()
  })
}
