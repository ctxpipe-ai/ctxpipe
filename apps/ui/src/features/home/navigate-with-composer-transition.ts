import { flushSync } from "react-dom"

export function navigateWithComposerTransition(apply: () => void) {
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    apply()
    return
  }
  document.startViewTransition(() => {
    flushSync(apply)
  })
}
