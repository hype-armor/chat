import { describe, expect, it, vi } from 'vitest'
import { trackVisualViewport } from './useVisualViewport'

function setup(supported = true) {
  const viewport = Object.assign(new EventTarget(), { height: 844, scale: 1 })
  const browser = Object.assign(new EventTarget(), {
    visualViewport: supported ? viewport : null,
    innerHeight: 844,
    scrollTo: vi.fn(),
  })
  const properties = new Map<string, string>()
  const style = {
    setProperty: (name: string, value: string) => properties.set(name, value),
    removeProperty: (name: string) => properties.delete(name),
  }
  const stop = trackVisualViewport(browser as unknown as Window, style as unknown as CSSStyleDeclaration)
  return { viewport, browser, properties, stop }
}

describe('visual viewport layout', () => {
  it('sets the height and removes the bottom inset only beyond the keyboard threshold', () => {
    const { viewport, browser, properties, stop } = setup()
    expect(properties.get('--app-height')).toBe('844px')
    expect(properties.has('--safe-bottom')).toBe(false)
    viewport.height = 744
    viewport.dispatchEvent(new Event('resize'))
    expect(properties.has('--safe-bottom')).toBe(false)
    viewport.height = 500
    viewport.dispatchEvent(new Event('resize'))
    expect(properties.get('--app-height')).toBe('500px')
    expect(properties.get('--safe-bottom')).toBe('0px')
    expect(browser.scrollTo).toHaveBeenLastCalledWith(0, 0)
    viewport.height = 844
    viewport.dispatchEvent(new Event('resize'))
    expect(properties.get('--app-height')).toBe('844px')
    expect(properties.has('--safe-bottom')).toBe(false)
    stop!()
  })

  it('keeps the normal safe area when Android resizes both viewports', () => {
    const { viewport, browser, properties, stop } = setup()
    viewport.height = browser.innerHeight = 500
    browser.dispatchEvent(new Event('resize'))
    expect(properties.get('--app-height')).toBe('500px')
    expect(properties.has('--safe-bottom')).toBe(false)
    stop!()
  })

  it('resets document panning on scroll events but leaves pinch zoom alone', () => {
    const { viewport, browser, properties, stop } = setup()
    browser.scrollTo.mockClear()
    viewport.dispatchEvent(new Event('scroll'))
    browser.dispatchEvent(new Event('scroll'))
    expect(browser.scrollTo).toHaveBeenCalledTimes(2)
    viewport.scale = 2
    viewport.height = 422
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    expect(properties.get('--app-height')).toBe('844px')
    expect(properties.has('--safe-bottom')).toBe(false)
    expect(browser.scrollTo).toHaveBeenCalledTimes(2)
    stop!()
  })

  it('cleans up variables and all listeners when chat is hidden or unmounted', () => {
    const { viewport, browser, properties, stop } = setup()
    stop!()
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    browser.dispatchEvent(new Event('resize'))
    browser.dispatchEvent(new Event('scroll'))
    expect(properties.size).toBe(0)
    expect(browser.scrollTo).toHaveBeenCalledTimes(1)
  })

  it('keeps the CSS fallback when VisualViewport is unavailable', () => {
    const { properties, browser, stop } = setup(false)
    expect(properties.size).toBe(0)
    expect(browser.scrollTo).not.toHaveBeenCalled()
    expect(stop).toBeUndefined()
  })
})
