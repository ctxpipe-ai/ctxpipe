"use client"

import { IconMenu2, IconX } from "@tabler/icons-react"
import { useShellLayout } from "@/components/ShellLayoutContext"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

/** Opens the overlay SideNav. Visible only below `md`; hidden while the drawer is open. */
export function OverlayNavMenuButton(props: {
  className?: string
}) {
  const { navOpen, toggleNav } = useShellLayout()

  return (
    <button
      type="button"
      aria-label="Open navigation"
      onClick={toggleNav}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg md:hidden",
        "border-0 bg-transparent text-zinc-400 transition-colors",
        "hover:bg-teal-900/30 hover:text-zinc-50",
        focusVisibleClassName,
        navOpen && "hidden",
        props.className,
      )}
    >
      <IconMenu2 className="size-4" stroke={1.6} aria-hidden />
    </button>
  )
}

export function OverlayNavCloseButton(props: {
  className?: string
}) {
  const { setNavOpen } = useShellLayout()

  return (
    <button
      type="button"
      aria-label="Close navigation"
      onClick={() => setNavOpen(false)}
      className={cn(
        "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg md:hidden",
        "border-0 bg-transparent text-zinc-400 transition-colors",
        "hover:bg-teal-900/30 hover:text-zinc-50",
        focusVisibleClassName,
        props.className,
      )}
    >
      <IconX className="size-4" stroke={1.6} aria-hidden />
    </button>
  )
}
