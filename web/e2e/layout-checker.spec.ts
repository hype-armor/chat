import { expect, test } from './fixtures'
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

for (const left of [0, 300]) {
  test(`SVG clipping preserves the non-HTML width fallback at ${left}px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await page.setContent(`<!doctype html>
      <svg style="position: fixed; left: ${left}px; top: 0; overflow: hidden" width="100" height="40">
        <rect id="svg-child" width="200" height="20" />
      </svg>
    `)
    expect(await page.locator('svg').evaluate((svg) => 'offsetWidth' in svg)).toBe(false)
    const report = await layoutReport(page)
    if (left === 0) expect(report).toEqual([])
    else expect(report).toEqual(expect.arrayContaining([
      expect.objectContaining({ problem: 'off-screen content', element: expect.stringContaining('#svg-child ') }),
    ]))
  })
}

for (const [borderLeft, borderRight] of [[0, 0], [12, 20]]) {
  for (const origin of ['top left', 'center'] as const) {
    test(`scaled clipping uses viewport coordinates: borders ${borderLeft}/${borderRight}, origin ${origin}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 })
      const left = origin === 'center' ? -(600 + borderLeft + borderRight) / 4 : 0
      await page.setContent(`<!doctype html>
        <div style="position: fixed; left: ${left}px; top: 0; width: 600px; height: 80px;
          overflow: hidden; transform: scale(.5); transform-origin: ${origin};
          border-left: ${borderLeft}px solid; border-right: ${borderRight}px solid">
          <div id="scaled-child" style="width: 800px; height: 80px"></div>
        </div>
      `)
      const contentRight = (borderLeft + 600) / 2
      const borderBoxRight = (borderLeft + 600 + borderRight) / 2
      const box = (await page.locator('#scaled-child').boundingBox())!
      // The child box exceeds the viewport, but its painted content does not.
      expect(box.x + box.width).toBeGreaterThan(320)
      expect(await page.locator('body').evaluate((body, x) =>
        body.ownerDocument.elementFromPoint(x, 30)?.id, contentRight - 1)).toBe('scaled-child')
      expect(await page.locator('body').evaluate((body, x) =>
        body.ownerDocument.elementFromPoint(x, 30)?.id, borderBoxRight + 1)).not.toBe('scaled-child')
      expect(await layoutReport(page)).toEqual([])
    })
  }

  test(`scaled clipping still reports visible overflow: borders ${borderLeft}/${borderRight}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await page.setContent(`<!doctype html>
      <div style="position: fixed; left: 0; top: 0; width: 200px; height: 40px;
        overflow: hidden; transform: scale(2); transform-origin: top left;
        border-left: ${borderLeft}px solid; border-right: ${borderRight}px solid">
        <div id="scaled-child" style="width: 300px; height: 40px"></div>
      </div>
    `)
    expect(await page.locator('body').evaluate((body) =>
      body.ownerDocument.elementFromPoint(319, 30)?.id)).toBe('scaled-child')
    expect(await layoutReport(page)).toEqual(expect.arrayContaining([
      expect.objectContaining({ problem: 'off-screen content', element: expect.stringContaining('#scaled-child ') }),
    ]))
  })
}

test('clipping uses the combined scale of nested containers', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <div style="position: fixed; left: 0; top: 0; width: 600px; height: 160px;
      transform: scale(.5); transform-origin: top left; overflow: hidden">
      <div style="width: 600px; height: 160px; transform: scale(.5); transform-origin: top left; overflow: hidden">
        <div id="scaled-child" style="width: 1600px; height: 160px"></div>
      </div>
    </div>
  `)
  expect(await page.locator('body').evaluate((body) =>
    body.ownerDocument.elementFromPoint(149, 20)?.id)).toBe('scaled-child')
  expect(await page.locator('body').evaluate((body) =>
    body.ownerDocument.elementFromPoint(151, 20)?.id)).not.toBe('scaled-child')
  expect(await layoutReport(page)).toEqual([])
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
  await page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).showModal())
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
  await page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).showModal())
  expect(await layoutReport(page)).toEqual([])
  // Clipping ancestors within the dialog also remain effective.
  await page.locator('dialog').evaluate((dialog) => {
    dialog.style.overflow = 'visible'
    dialog.innerHTML = '<div style="width: 50px; overflow: hidden"><div style="width: 600px; height: 20px"></div></div>'
  })
  expect(await layoutReport(page)).toEqual([])
})

test('disappearing overflow dialogs fail with their last geometry and screen label', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.setContent(`<!doctype html>
    <dialog style="position: fixed; left: 300px; width: 100px; max-width: none; margin: 0">Refused</dialog>
  `)
  const dialog = page.locator('dialog')
  await dialog.evaluate((element) => {
    (element as HTMLDialogElement).showModal()
    const measure = element.getBoundingClientRect.bind(element)
    element.getBoundingClientRect = () => {
      element.dataset.measured = 'true'
      return measure()
    }
  })
  const screen = 'transient refusal: 320×640 dark'
  const failure = expectDialogLayout(page, dialog, screen).then(() => '', (error: Error) => error.message)
  // Wait for a measured poll, then change geometry to verify the last report wins.
  await expect(dialog).toHaveAttribute('data-measured', 'true')
  await dialog.evaluate((element) => {
    element.style.left = '280px'
    element.dataset.measured = 'false'
  })
  await expect(dialog).toHaveAttribute('data-measured', 'true')
  const lastReport = await layoutReport(page)
  expect(lastReport).toEqual(expect.arrayContaining([
    expect.objectContaining({ problem: 'off-screen content' }),
  ]))
  await dialog.evaluate((element) => (element as HTMLDialogElement).close())
  const message = await failure
  expect(message).toContain('dialog must remain visible after layout polling')
  expect(message).toContain(screen)
  expect(message).toContain(JSON.stringify(lastReport, null, 2))
  expect(await layoutReport(page)).toEqual([])
})

test('dialog layout polling accepts a visible dialog with no defects', async ({ page }) => {
  await page.setContent('<!doctype html><dialog>Refused</dialog>')
  const dialog = page.locator('dialog')
  await dialog.evaluate((element) => (element as HTMLDialogElement).showModal())
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
