import { useLayoutEffect } from 'react'

export function trackVisualViewport(browser: Window, style: CSSStyleDeclaration): (() => void) | undefined {
  const viewport = browser.visualViewport
  if (!viewport) return
  let keyboardOpen = false

  const update = () => {
    // Pinch zoom is not a keyboard resize; leave its size and panning alone.
    if (viewport.scale !== 1) return
    style.setProperty('--app-height', `${viewport.height}px`)
    const wasOpen = keyboardOpen
    keyboardOpen = viewport.height < browser.innerHeight - 100
    if (keyboardOpen) {
      style.setProperty('--safe-bottom', '0px')
    } else {
      style.removeProperty('--safe-bottom')
    }
    // iOS pans the document to the focused textarea without resizing 100dvh.
    if (keyboardOpen || wasOpen) browser.scrollTo(0, 0)
  }

  update()
  viewport.addEventListener('resize', update)
  viewport.addEventListener('scroll', update)
  browser.addEventListener('resize', update)
  browser.addEventListener('scroll', update)
  return () => {
    viewport.removeEventListener('resize', update)
    viewport.removeEventListener('scroll', update)
    browser.removeEventListener('resize', update)
    browser.removeEventListener('scroll', update)
    style.removeProperty('--app-height')
    style.removeProperty('--safe-bottom')
  }
}

export function useVisualViewport(enabled: boolean) {
  useLayoutEffect(() => {
    if (enabled) return trackVisualViewport(window, document.documentElement.style)
  }, [enabled])
}
