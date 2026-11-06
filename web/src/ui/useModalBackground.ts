import { type RefObject, useLayoutEffect } from 'react'

/** Make every background branch inert, not the modal's ancestors or its scrim. */
export function useModalBackground(
  modal: RefObject<HTMLElement | null>,
  scrim: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useLayoutEffect(() => {
    if (!active || !modal.current) return
    const changed = new Set<HTMLElement>()
    const suppressBackground = () => {
      for (let branch: HTMLElement | null = modal.current; branch?.parentElement; branch = branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling === branch || sibling === scrim.current || !(sibling instanceof HTMLElement) || sibling.inert) continue
          sibling.inert = true
          changed.add(sibling)
        }
        if (branch.parentElement === document.body) break
      }
    }
    suppressBackground()
    // Update notices can mount outside Chat while a modal is already open.
    const observer = new MutationObserver(suppressBackground)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const element of changed) element.inert = false
    }
  }, [modal, scrim, active])
}
