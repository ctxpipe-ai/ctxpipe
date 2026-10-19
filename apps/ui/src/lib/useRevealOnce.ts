import { useEffect, useState } from "react"
import { flushSync } from "react-dom"

/**
 * Returns true once `ready` has been true. A block that may not show uses it
 * to appear without a layout jump: the change runs inside a view transition,
 * so the browser moves the blocks below with transforms (never height).
 * Only the first appearance animates. A value that is ready on mount, or a
 * user who prefers reduced motion, gets the change at once. So does a caller
 * that sets `immediate` (the page fades in as a whole).
 */
export function useRevealOnce(ready: boolean, immediate = false): boolean {
  const [shown, setShown] = useState(ready)
  // An immediate caller sets it while it renders, so no extra commit follows.
  if (immediate && ready && !shown) setShown(true)
  useEffect(() => {
    if (!ready || shown) return
    const animate =
      typeof document.startViewTransition === "function" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (animate) {
      document.startViewTransition(() => flushSync(() => setShown(true)))
    } else {
      setShown(true)
    }
  }, [ready, shown])
  return shown
}
