/**
 * Shared Workspace split chrome (conversation + tools panes).
 * Keep visual tokens in sync across both columns.
 *
 * Breakpoints (Tailwind defaults — prefer responsive classes over JS):
 * - `max-md` (<768px): SideNav overlay + hamburger; owning pane edge-flush
 * - `max-lg` (<1024px): single workspace column
 * - `lg:` (≥1024px): chat + tools side by side
 */

/** Outer top inset — optically aligned with SideNav header. Add `flex-1` at call sites that should grow. */
export const workspaceChromeOuterClassName =
  "flex min-h-0 min-w-0 flex-col pb-3 pt-[6.5px]"

/**
 * Active tab: 12px x-padding, 37px tall including the 1px hairline.
 * Idle tab: 32px face + 2px (`0.5`) inset; `-translate-y-px` restores the gap
 * above the card after the strip sits 1px over the hairline.
 */
export const workspaceChromeTabClassName = [
  "relative z-10 box-border inline-flex h-[37px] shrink-0 items-center justify-center px-3",
  "rounded-t-lg border border-b-0 border-white/[0.06] bg-card",
  "text-sm font-medium leading-none text-foreground",
].join(" ")

export const workspaceChromeTabIdleClassName = [
  "box-border my-0.5 -translate-y-px inline-flex h-8 shrink-0 cursor-pointer items-center justify-center px-3",
  "rounded-lg border-0 bg-transparent",
  "text-sm font-medium leading-none text-zinc-400",
  "transition-colors hover:bg-teal-900/30 hover:text-zinc-50",
].join(" ")

/** Gap between conversation + pane tabs (both columns). Sit 1px over the card hairline. */
export const workspaceChromeTabStripClassName =
  "relative z-10 -mb-px flex items-end gap-0.5"

export function workspaceChromeIconTabClassName(active: boolean): string {
  return active
    ? workspaceChromeTabClassName
    : workspaceChromeTabIdleClassName
}

/**
 * When the pane owns the viewport (nav overlay, `max-md`): drop side/bottom
 * inset, card radius, and those borders so the surface is edge-flush.
 */
export const workspaceChromeOuterFlushClassName = "max-md:pb-0 max-md:pr-0"

const workspaceChromeCardFlushClassName =
  "max-md:rounded-none max-md:border-x-0 max-md:border-b-0"

export const workspaceChromeCardClassName = [
  "relative flex min-h-0 flex-1 flex-col overflow-hidden",
  "rounded-lg rounded-tl-none border border-white/[0.06]",
  "bg-card text-card-foreground",
  workspaceChromeCardFlushClassName,
].join(" ")

/** Tools pane card. Top-left radius is restored unless Files leads the strip. */
export const workspaceChromeCardPaneClassName = [
  "relative flex min-h-0 flex-1 flex-col overflow-hidden",
  "rounded-lg border border-white/[0.06]",
  "bg-card text-card-foreground",
  workspaceChromeCardFlushClassName,
].join(" ")
