import {
  focusVisibleClassName,
  focusVisibleRingClassName,
} from "@/lib/focus-styles"

/** Shared SideNav row chrome — keep static items and workspace rows aligned. */
export const sideNavIconGutterClassName =
  "flex size-8 shrink-0 items-center justify-center text-zinc-400 [&_svg]:size-4 [&_svg]:stroke-[1.4] group-hover:text-zinc-200 group-aria-[current=page]:text-white group-data-[active=true]:text-white"

/** Trailing affordances (⌘K, compose) — size only; no extra right margin. */
export const sideNavTrailingSlotClassName =
  "inline-flex size-8 shrink-0 items-center justify-center"

/** Label / trailing slot fade while the rail width animates. */
export const sideNavRevealClassName =
  "min-w-0 overflow-hidden whitespace-nowrap transition-[opacity,flex-grow,flex-basis,width] duration-200 ease-out motion-reduce:transition-none"

export function sideNavLabelClassName(expanded: boolean): string {
  return [
    sideNavRevealClassName,
    // Overlay drawer (< md) always shows labels even if the rail preference is collapsed.
    expanded
      ? "flex-1 opacity-100"
      : "w-0 flex-none opacity-0 max-md:w-auto max-md:flex-1 max-md:opacity-100",
  ].join(" ")
}

export function sideNavRowClassName(options: {
  active?: boolean
  interactive?: boolean
  /** When false, skip shared focus ring (footer uses its own hover outline). */
  focusRing?: boolean
}): string {
  const { active = false, interactive = true, focusRing = true } = options
  return [
    // Always left-aligned icon gutter so collapse only clips labels, icons stay put.
    "group relative mx-1.5 flex h-8 w-[calc(100%-0.75rem)] items-center rounded-lg text-sm font-normal transition-colors",
    interactive
      ? "cursor-pointer hover:bg-teal-900/30 hover:text-zinc-50"
      : "cursor-default",
    interactive && focusRing ? focusVisibleClassName : "",
    active ? "bg-zinc-900/70 text-zinc-100" : "text-zinc-300",
  ]
    .filter(Boolean)
    .join(" ")
}

export const sideNavActiveBarClassName =
  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-primary-400 opacity-0 transition-opacity group-aria-[current=page]:opacity-100 group-data-[active=true]:opacity-100"

/** Footer org/user triggers — same gutters as menu rows, taller for two-line labels. */
export function sideNavAccountTriggerClassName(expanded: boolean): string {
  // Hover: 3px transparent→teal wash. Focus: shared product ring.
  const outlineHover = [
    "outline-solid outline-[3px] outline-offset-0 outline-transparent hover:outline-teal-900/30",
    focusVisibleRingClassName,
  ].join(" ")
  if (!expanded) {
    return [
      sideNavRowClassName({ active: false, focusRing: false }),
      outlineHover,
    ].join(" ")
  }
  return [
    sideNavRowClassName({ active: false, focusRing: false }),
    outlineHover,
    // Override better-auth-ui Button !p-2; height comes from two-line content.
    "h-auto min-h-8 !p-0",
  ].join(" ")
}

/** Dimmer avatar plate for org/user fallbacks (kept for real avatar images). */
export const sideNavAccountAvatarClassNames = {
  base: "size-8 !my-0 rounded-lg bg-zinc-900/60 text-zinc-500",
  image: "rounded-lg",
  fallback: "rounded-lg bg-zinc-900/60 text-xs font-normal text-zinc-500",
  fallbackIcon: "size-4 stroke-[1.4] text-zinc-500",
  skeleton: "size-8 rounded-lg bg-zinc-900/60",
}

export const sideNavAccountOrgViewClassNames = {
  base: "min-w-0 flex-1 gap-2",
  avatar: sideNavAccountAvatarClassNames,
  content: "min-w-0 gap-0 leading-none",
  title: "truncate text-sm !font-normal !leading-none text-zinc-300",
  subtitle: "mt-0.5 truncate text-xs !font-normal !leading-none text-zinc-500",
}

export const sideNavAccountUserViewClassNames = {
  base: "min-w-0 flex-1 gap-2",
  avatar: sideNavAccountAvatarClassNames,
  content: "min-w-0 gap-0 leading-none",
  title: "truncate text-sm !font-normal !leading-none text-zinc-300",
  subtitle: "mt-0.5 truncate text-xs !font-normal !leading-none text-zinc-500",
}
