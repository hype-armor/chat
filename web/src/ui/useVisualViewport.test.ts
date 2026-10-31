import { describe, expect, it, vi } from 'vitest'
import { trackVisualViewport, visualViewportProperties } from './useVisualViewport'

function setup(viewport: VisualViewport | null = Object.assign(new EventTarget(), {
  height: 844, offsetTop: 0, scale: 1,
}) as VisualViewport) {
  const properties = new Map<string, string>()
  const style = {
    setProperty: (name: string, value: string) => { properties.set(name, value) },
    removeProperty: (name: string) => { properties.delete(name); return '' },
  }
  let callback: FrameRequestCallback | undefined
  const win = {
    visualViewport: viewport,
    innerHeight: 844,
    requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => { callback = cb; return 1 }),
    cancelAnimationFrame: vi.fn(() => { callback = undefined }),
  }
  const dispose = trackVisualViewport(win, style)
  const change = (values: Partial<VisualViewport>, event = 'resize') => {
    Object.assign(viewport!, values)
    viewport!.dispatchEvent(new Event(event))
  }
  const flush = () => { const cb = callback; callback = undefined; cb?.(0) }
  return { properties, win, dispose, change, flush }
}

describe('visualViewportProperties', () => {
  it('aligns with an iOS keyboard pan and removes the bottom safe area', () => {
    expect(visualViewportProperties({ height: 500, offsetTop: 344, scale: 1 }, 844)).toEqual({
      '--app-height': '500px', '--app-top': '344px', '--safe-bottom': '0px',
    })
  })

  it('keeps the safe area when the layout viewport also shrinks (Android)', () => {
    expect(visualViewportProperties({ height: 500, offsetTop: 0, scale: 1 }, 500)).toEqual({
      '--app-height': '500px', '--app-top': '0px', '--safe-bottom': undefined,
    })
  })

  it('ignores pinch zoom and unavailable VisualViewport', () => {
    expect(visualViewportProperties({ height: 400, offsetTop: 100, scale: 2 }, 844)).toBeUndefined()
    expect(visualViewportProperties(null, 844)).toBeUndefined()
  })
})

describe('trackVisualViewport', () => {
  it('updates height on resize and top on scroll, coalescing animation frames', () => {
    const s = setup()
    s.change({ height: 500, offsetTop: 200 })
    s.change({ offsetTop: 344 }, 'scroll')
    expect(s.win.requestAnimationFrame).toHaveBeenCalledTimes(1)
    s.flush()
    expect(Object.fromEntries(s.properties)).toEqual({
      '--app-height': '500px', '--app-top': '344px', '--safe-bottom': '0px',
    })
    s.change({ offsetTop: 300 }, 'scroll')
    s.flush()
    expect(s.properties.get('--app-top')).toBe('300px')
    s.dispose()
  })

  it('resets height, top and the safe-area override when the keyboard closes', () => {
    const s = setup()
    s.change({ height: 500, offsetTop: 344 })
    s.flush()
    s.change({ height: 844, offsetTop: 0 })
    s.flush()
    expect(Object.fromEntries(s.properties)).toEqual({ '--app-height': '844px', '--app-top': '0px' })
    s.dispose()
    expect(s.properties.size).toBe(0)
  })

  it('leaves layout variables unchanged during pinch zoom', () => {
    const s = setup()
    s.change({ height: 400, offsetTop: 100, scale: 2 })
    s.flush()
    expect(Object.fromEntries(s.properties)).toEqual({ '--app-height': '844px', '--app-top': '0px' })
    s.change({ height: 844, offsetTop: 0, scale: 1 })
    s.flush()
    expect(s.properties.get('--app-height')).toBe('844px')
    s.dispose()
  })

  it('does not set variables or schedule frames without VisualViewport', () => {
    const s = setup(null)
    expect(s.properties.size).toBe(0)
    expect(s.win.requestAnimationFrame).not.toHaveBeenCalled()
    s.dispose()
  })

  it('removes listeners, pending frames and variables on cleanup', () => {
    const s = setup()
    s.change({ height: 500 })
    s.dispose()
    expect(s.win.cancelAnimationFrame).toHaveBeenCalledWith(1)
    s.flush()
    s.change({ offsetTop: 344 }, 'scroll')
    s.change({ height: 400 })
    expect(s.win.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(s.properties.size).toBe(0)
  })
})
