import { expect, test } from '@playwright/test'
import { layoutReport } from './layout'

test('reports page overflow, sideways scrolling, clipped text and oversized choices with geometry', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <div id="wide" style="width: 500px">Outside the page</div>
    <div id="scroll" style="width: 80px; overflow-x: auto"><div style="width: 200px">Scrollable</div></div>
    <div id="text" style="width: 30px; white-space: nowrap; overflow: hidden">Clipped label</div>
    <label>Privacy choice<input id="check" type="checkbox" style="width: 100px; height: 30px"></label>
    <input id="radio" type="radio" aria-label="Report reason" style="width: 30px; height: 100px">
    <div style="height: 900px"></div>
  `)
  const report = await layoutReport(page, true)
  for (const [problem, element] of [
    ['page overflow-x', 'html'],
    ['page overflow-y', 'html'],
    ['sideways scroll', 'div#scroll'],
    ['off-screen content', 'div#wide'],
    ['clipped text', 'div#text'],
    ['oversized checkbox/radio', 'input#check'],
    ['oversized checkbox/radio', 'input#radio'],
  ]) {
    expect(report).toEqual(expect.arrayContaining([expect.objectContaining({
      problem, element: expect.stringContaining(element), box: expect.any(String),
      client: expect.any(String), scroll: expect.any(String),
    })]))
  }
  expect(report.find(({ element }) => element.includes('#check'))!.element).toContain('Privacy choice')
  expect(report.find(({ element }) => element.includes('#radio'))!.element).toContain('Report reason')
  expect((await layoutReport(page)).some(({ problem }) => problem === 'page overflow-y')).toBe(false)
})

test('allows deliberate clipping, ellipsis, textarea scrolling and hidden content', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <div style="width: 100px; overflow-x: hidden"><div style="width: 600px">Clipped child</div></div>
    <div style="width: 40px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">Ellipsized label</div>
    <textarea wrap="off" style="width: 40px; overflow-x: auto"></textarea>
    <div class="visually-hidden" style="position: fixed; left: -100px">Screen reader only</div>
    <div hidden><input type="checkbox" style="width: 100px"></div>
    <div inert style="position: fixed; left: -200px"><span>Inert child</span></div>
    <div style="visibility: hidden; position: fixed; left: -200px">Invisible</div>
    <div style="opacity: 0; position: fixed; left: -200px">Transparent</div>
    <details><summary>Closed section</summary><div style="width: 900px">Not rendered</div></details>
  `)
  await page.locator('textarea').fill('Long unbroken draft '.repeat(30))
  expect(await layoutReport(page)).toEqual([])
})

test('an off-screen clipping ancestor does not hide a layout defect', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <div id="clip" style="position: fixed; left: 300px; width: 100px; overflow: hidden">
      <span id="child" style="display: block; width: 200px">Off-screen child</span>
    </div>
  `)
  const report = await layoutReport(page)
  expect(report).toEqual(expect.arrayContaining([
    expect.objectContaining({ problem: 'off-screen content', element: expect.stringContaining('#child') }),
  ]))
})

test('respects the one-pixel scroll tolerance and 28px choice limit', async ({ page }) => {
  await page.setContent(`<!doctype html>
    <div style="width: 80px; overflow-x: auto"><div style="width: 81px">One pixel</div></div>
    <input type="checkbox" style="width: 28px; height: 28px">
    <input type="radio" style="width: 28px; height: 28px">
  `)
  expect(await layoutReport(page)).toEqual([])
  await page.locator('input[type="radio"]').evaluate((element) => { element.style.height = '29px' })
  expect(await layoutReport(page)).toEqual([
    expect.objectContaining({ problem: 'oversized checkbox/radio' }),
  ])
})
