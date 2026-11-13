import { useLayoutEffect, useRef } from 'react'

type Viewport = Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>

/**
 * `tallestHeight` is the largest viewport height seen since mount, which is the
 * height without a keyboard. Comparing against the current `innerHeight` fails
 * once the browser resizes the layout viewport for the keyboard too, as
 * `interactive-widget=resizes-content` requests.
 */
export function visualViewportProperties(viewport: Viewport | null, tallestHeight: number) {
  if (!viewport || viewport.scale !== 1) return undefined
  return {
    '--app-height': `${viewport.height}px`,
    '--app-top': `${viewport.offsetTop}px`,
    '--safe-bottom': viewport.height < tallestHeight - 100 ? '0px' : undefined,
  }
}

export function trackVisualViewport(
  win: Pick<Window, 'visualViewport' | 'requestAnimationFrame' | 'cancelAnimationFrame'>,
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>,
) {
  const viewport = win.visualViewport
  if (!viewport) return () => {}
  let tallestHeight = viewport.height
  const update = () => {
    if (viewport.height > tallestHeight) tallestHeight = viewport.height
    const properties = visualViewportProperties(viewport, tallestHeight)
    if (!properties) return
    for (const [name, value] of Object.entries(properties)) {
      if (value === undefined) style.removeProperty(name)
      else style.setProperty(name, value)
    }
  }
  let frame: number | undefined
  const schedule = () => {
    if (frame !== undefined) return
    frame = win.requestAnimationFrame(() => {
      frame = undefined
      update()
    })
  }
  update()
  viewport.addEventListener('resize', schedule)
  viewport.addEventListener('scroll', schedule)
  return () => {
    viewport.removeEventListener('resize', schedule)
    viewport.removeEventListener('scroll', schedule)
    if (frame !== undefined) win.cancelAnimationFrame(frame)
    for (const name of ['--app-height', '--app-top', '--safe-bottom']) style.removeProperty(name)
  }
}

export function useVisualViewport() {
  useLayoutEffect(() => trackVisualViewport(window, document.documentElement.style), [])
}

export function useBannerHeight<T extends HTMLElement>(property: string, active: boolean) {
  const banner = useRef<T>(null)
  useLayoutEffect(() => {
    if (!active) return
    const element = banner.current!
    const style = document.documentElement.style
    const measure = () => style.setProperty(property, `${element.getBoundingClientRect().height}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      style.removeProperty(property)
    }
  }, [property, active])
  return banner
}
