import { expect, type Locator, type Page } from '@playwright/test'

/** Test-only geometry audit, evaluated in the real browser (including WebKit). */
export async function layoutReport(page: Page, chat = false) {
  return page.locator('body').evaluate((body, chat) => {
    const doc = body.ownerDocument
    const win = doc.defaultView!
    type Element = ReturnType<typeof body.querySelectorAll>[number]
    const width = doc.documentElement.clientWidth
    const report: { problem: string; element: string; box: string; client: string; scroll: string }[] = []
    const describe = (element: Element) => {
      const label = element.getAttribute('aria-label') || element.closest('label')?.textContent
        || element.textContent || element.getAttribute('title') || ''
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`
        + `${element.getAttribute('class') ? `.${element.getAttribute('class')!.trim().replace(/\s+/g, '.')}` : ''}`
        + ` "${label.trim().replace(/\s+/g, ' ').slice(0, 100)}"`
    }
    const add = (problem: string, element: Element) => {
      const rect = element.getBoundingClientRect()
      report.push({
        problem, element: describe(element),
        box: `left=${rect.left.toFixed(1)}, right=${rect.right.toFixed(1)}, ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`,
        client: `${element.clientWidth}×${element.clientHeight}`,
        scroll: `${element.scrollWidth}×${element.scrollHeight}`,
      })
    }
    // Out-of-flow descendants escape overflow between themselves and their
    // containing block. Fixed positioning ignores merely positioned ancestors.
    const establishesContainingBlock = (style: ReturnType<typeof win.getComputedStyle>, position: 'absolute' | 'fixed') =>
      style.display !== 'contents' && (
        (position === 'absolute' && style.position !== 'static')
        || [style.transform, style.translate, style.rotate, style.scale, style.perspective,
          style.filter, style.backdropFilter].some((value) => value && value !== 'none')
        || style.transformStyle === 'preserve-3d'
        || /\b(layout|paint|strict|content)\b/.test(style.contain)
        || style.willChange.split(',').some((property: string) => [
          'transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter', 'transform-style',
        ].includes(property.trim()))
        || style.contentVisibility === 'auto'
      )
    const root = doc.scrollingElement!
    if (root.scrollWidth > root.clientWidth) add('page overflow-x', root)
    if (chat && root.scrollHeight > root.clientHeight) add('page overflow-y', root)
    for (const element of [body, ...body.querySelectorAll('*')]) {
      if (element.closest('.visually-hidden, [hidden], [inert]')) continue
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const style = win.getComputedStyle(element)
      if (/^(auto|scroll)$/.test(style.overflowX) && element.tagName !== 'TEXTAREA'
        && element.scrollWidth > element.clientWidth + 1) add('sideways scroll', element)

      // Intersect with horizontal clipping ancestors, not just their presence:
      // an off-screen clipping container must not excuse its off-screen children.
      // Modal dialogs enter the top layer: only ancestors inside that modal clip.
      let left = rect.left
      let right = rect.right
      let positioned: 'absolute' | 'fixed' | null = null
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = ancestor === element ? style : win.getComputedStyle(ancestor)
        if (ancestor !== element && (!positioned || establishesContainingBlock(ancestorStyle, positioned))) {
          positioned = null
          if (ancestorStyle.overflowX !== 'visible') {
            const bounds = ancestor.getBoundingClientRect()
            left = Math.max(left, bounds.left + ancestor.clientLeft)
            right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth)
          }
        }
        if (ancestor.matches(':modal')) break
        // Keep an unresolved fixed escape when walking through absolute parents.
        if (!positioned && (ancestorStyle.position === 'absolute' || ancestorStyle.position === 'fixed')) {
          positioned = ancestorStyle.position
        }
      }
      if (right > left && (left < -1 || right > width + 1)) add('off-screen content', element)
      if (element.matches('input[type="checkbox"], input[type="radio"]') && (rect.width > 28 || rect.height > 28)) {
        add('oversized checkbox/radio', element)
      }
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())
      if (ownText && style.overflowX !== 'visible' && element.scrollWidth > element.clientWidth
        && style.textOverflow !== 'ellipsis') add('clipped text', element)
    }
    return report
  }, chat)
}

export async function expectLayout(page: Page, screen: string, chat = false) {
  // Retry through resize, font loading and panel transitions; persistent defects
  // still report every offending element rather than an unexplained width mismatch.
  await expect.poll(() => layoutReport(page, chat), { message: screen }).toEqual([])
}

/** A transient dialog must survive the poll; dismissal is not a layout fix. */
export async function expectDialogLayout(page: Page, dialog: Locator, screen: string, chat = false) {
  await expectLayout(page, screen, chat)
  expect(await dialog.isVisible(), 'dialog must remain visible after layout polling').toBe(true)
}

export const layoutViewports = [
  { width: 320, height: 640, colorScheme: 'dark' },
  { width: 390, height: 844, colorScheme: 'dark' },
  { width: 768, height: 1024, colorScheme: 'light' },
  { width: 1280, height: 800, colorScheme: 'light' },
] as const

export async function auditLayouts(page: Page, screen: string, chat = true) {
  for (const { width, height, colorScheme } of layoutViewports) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme })
    await expectLayout(page, `${screen}: ${width}×${height} ${colorScheme}`, chat)
  }
}
