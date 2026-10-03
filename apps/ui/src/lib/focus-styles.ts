import { tv } from "tailwind-variants"

/**
 * Product focus-visible ring utilities (Operate UI).
 * Prefer these over ad-hoc teal outlines; keep hover washes separate.
 *
 * Use `outline-0` (not `outline-none`) so outline-style stays solid and
 * focus-visible can grow width — `outline-none` kills style and color-only
 * utilities paint nothing.
 */

/** Focus-visible ring only — layer on controls that already own a resting outline (e.g. hover wash). */
export const focusVisibleRingClassName =
  "focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal-400/60"

/** Full recipe for typical controls (native buttons, links without a persistent outline). */
export const focusVisibleClassName = [
  "outline-solid outline-0 outline-offset-1",
  focusVisibleRingClassName,
].join(" ")

/**
 * React Aria `tv` focus ring — same visual recipe via `isFocusVisible`.
 * Extend from this in `components/ui` primitives.
 */
export const focusRing = tv({
  base: "relative outline-solid outline-teal-400/60 forced-colors:outline-[Highlight] outline-offset-1",
  variants: {
    isFocusVisible: {
      false: "outline-0",
      true: "z-10 outline-2",
    },
  },
})
