import type { MouseEvent } from "react"

/**
 * Drops the second click of a double-click. A slide changes at once, so that
 * click can land on a button of the next slide and skip a step.
 */
export function ignoreRepeatClick(event: MouseEvent) {
  if (event.detail > 1) event.stopPropagation()
}
