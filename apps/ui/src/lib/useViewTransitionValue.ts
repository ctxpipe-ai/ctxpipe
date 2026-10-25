import { useEffect, useState } from "react"

import { updateInViewTransition } from "./updateInViewTransition"

/**
 * Returns `value`, but a change runs inside a view transition, so the
 * browser moves the blocks that the change shifts with transforms and not
 * with a layout jump. Use it for a block that comes and goes (`useRevealOnce`
 * does the same for the first appearance only). A value that is set on mount,
 * or a user who prefers reduced motion, gets the change at once.
 */
export function useViewTransitionValue(value: boolean): boolean {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    if (value === shown) return
    updateInViewTransition(() => setShown(value))
  }, [value, shown])
  return shown
}
