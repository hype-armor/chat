import { expect, test } from '@playwright/test'
import { expectDialogLayout, layoutReport } from './layout'

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

for (const position of ['fixed', 'absolute'] as const) {
  for (const wrapper of ['static', 'relative'] as const) {
    if (position === 'absolute' && wrapper === 'relative') continue
    test(`reports ${position} content escaping a ${wrapper} clipping wrapper`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 })
      await page.setContent(`<!doctype html>
        <div style="position: ${wrapper}; width: 100px; height: 100px; overflow: hidden">
          <div id="escaped" style="position: ${position}; left: 300px; top: 20px; width: 100px; height: 20px">
            <div id="escaped-child" style="width: 100px; height: 20px"></div>
          </div>
        </div>
      `)
      // Confirm that the browser does not clip this content at the wrapper.
      expect(await page.locator('body').evaluate((body) => body.ownerDocument.elementFromPoint(310, 30)?.id)).toBe('escaped-child')
      const report = await layoutReport(page)
      for (const id of ['#escaped ', '#escaped-child ']) {
        expect(report).toEqual(expect.arrayContaining([
          expect.objectContaining({ problem: 'off-screen content', element: expect.stringContaining(id) }),
        ]))
      }
    })
  }

  for (const containingBlock of [
    ...(position === 'absolute' ? ['position: relative'] : []),
    'transform: translateX(0)', 'translate: 0px', 'perspective: 1000px', 'filter: blur(0px)',
    'contain: layout', 'contain: paint', 'will-change: transform', 'transform-style: preserve-3d',
    'will-change: transform-style', 'content-visibility: auto',
  ]) {
    test(`${position} content respects clipping at its ${containingBlock} containing block`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 })
      await page.setContent(`<!doctype html>
        <div style="${containingBlock}; width: 100px; height: 100px; overflow: hidden">
          <div style="position: ${position}; left: 300px; top: 20px; width: 100px; height: 20px">
            <div id="clipped-child" style="width: 100px; height: 20px"></div>
          </div>
        </div>
      `)
      expect(await page.locator('body').evaluate((body) => body.ownerDocument.elementFromPoint(310, 30)?.id)).not.toBe('clipped-child')
      expect(await layoutReport(page)).toEqual([])
    })
  }

  test(`${position} content escapes a wrapper below its containing block`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await page.setContent(`<!doctype html>
      <div style="transform: translateX(0); width: 310px; height: 100px; overflow: visible">
        <div style="width: 100px; overflow: hidden">
          <div id="escaped" style="position: ${position}; left: 300px; top: 20px; width: 100px; height: 20px"></div>
        </div>
      </div>
    `)
    expect(await page.locator('body').evaluate((body) => body.ownerDocument.elementFromPoint(310, 30)?.id)).toBe('escaped')
    expect(await layoutReport(page)).toEqual(expect.arrayContaining([
      expect.objectContaining({ problem: 'off-screen content', element: expect.stringContaining('#escaped ') }),
    ]))
  })
}

test('a viewport-fixed descendant also escapes absolutely positioned ancestors', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <div style="position: relative; width: 100px; height: 100px; overflow: hidden">
      <div style="position: absolute; width: 100px; height: 100px; overflow: hidden">
        <div id="escaped" style="position: fixed; left: 300px; top: 20px; width: 100px; height: 20px"></div>
      </div>
    </div>
  `)
  expect(await page.locator('body').evaluate((body) => body.ownerDocument.elementFromPoint(310, 30)?.id)).toBe('escaped')
  expect(await layoutReport(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ problem: 'off-screen content', element: expect.stringContaining('#escaped ') }),
  ]))
})

test('reports modal overflow beyond an outer clipping ancestor', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <div style="width: 100px; overflow: hidden">
      <dialog id="modal" style="position: fixed; left: 300px; width: 100px; max-width: none;
        margin: 0; padding: 0; border: 0; overflow: visible">
        <div id="modal-child" style="width: 200px; height: 20px"></div>
      </dialog>
    </div>
  `)
  await page.locator('dialog').evaluate((dialog) => dialog.showModal())
  const report = await layoutReport(page)
  for (const id of ['#modal ', '#modal-child ']) {
    expect(report).toEqual(expect.arrayContaining([
      expect.objectContaining({ problem: 'off-screen content', element: expect.stringContaining(id) }),
    ]))
  }
})

test('preserves clipping inside a modal dialog', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <div style="width: 40px; overflow: hidden">
      <dialog style="position: fixed; left: 100px; width: 100px; margin: 0; padding: 0; border: 0; overflow: hidden">
        <div style="width: 600px; height: 20px"></div>
      </dialog>
    </div>
  `)
  await page.locator('dialog').evaluate((dialog) => dialog.showModal())
  expect(await layoutReport(page)).toEqual([])
  // Clipping ancestors within the dialog also remain effective.
  await page.locator('dialog').evaluate((dialog) => {
    dialog.style.overflow = 'visible'
    dialog.innerHTML = '<div style="width: 50px; overflow: hidden"><div style="width: 600px; height: 20px"></div></div>'
  })
  expect(await layoutReport(page)).toEqual([])
})

test('dialog layout polling cannot pass after an overflowing dialog disappears', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <dialog style="position: fixed; left: 300px; width: 100px; max-width: none; margin: 0">Refused</dialog>
  `)
  const dialog = page.locator('dialog')
  await dialog.evaluate((element) => element.showModal())
  expect(await layoutReport(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({ problem: 'off-screen content' }),
  ]))
  await dialog.evaluate((element) => { setTimeout(() => element.close(), 250) })
  await expect(expectDialogLayout(page, dialog, 'transient refusal'))
    .rejects.toThrow(/dialog must remain visible after layout polling/)
  expect(await layoutReport(page)).toEqual([])
})

test('dialog layout polling accepts a visible dialog with no defects', async ({ page }) => {
  await page.setContent('<!doctype html><dialog>Refused</dialog>')
  const dialog = page.locator('dialog')
  await dialog.evaluate((element) => element.showModal())
  await expectDialogLayout(page, dialog, 'visible refusal')
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
