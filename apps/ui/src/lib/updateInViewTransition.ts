import { flushSync } from "react-dom"

/**
 * Runs `update` in a view transition, so the browser moves the blocks that
 * the update shifts with transforms and not with a layout jump. A browser
 * without view transitions, or a user who prefers reduced motion, gets the
 * update at once.
 *
 * A later transition skips this one and rejects its `ready` promise with an
 * AbortError. The update still happens, so the rejection is not an error.
 * Nothing awaits `ready`, so the page would report it as unhandled.
 */
export function updateInViewTransition(update: () => void) {
  const animate =
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  if (!animate) {
    update()
    return
  }
  document.startViewTransition(() => flushSync(update)).ready.catch(() => {})
}
