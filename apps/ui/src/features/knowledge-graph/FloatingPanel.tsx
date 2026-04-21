import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/* Every floating panel in the explorer shares the same dark sharp-cornered
 * chrome — consolidate so tweaks land in one place. */
export function FloatingPanel({
  className,
  children,
  role,
  ariaLabel,
}: {
  className?: string
  children: ReactNode
  role?: string
  ariaLabel?: string
}) {
  return (
    <div
      className={cn(
        "rounded-none border border-zinc-800/95 bg-zinc-950/90 shadow-xl shadow-black/40 backdrop-blur-md",
        className,
      )}
      {...(role ? { role } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    >
      {children}
    </div>
  )
}

export function PanelLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p
      className={cn(
        "text-[12px] font-semibold uppercase tracking-[0.18em] text-zinc-500",
        className,
      )}
    >
      {children}
    </p>
  )
}
