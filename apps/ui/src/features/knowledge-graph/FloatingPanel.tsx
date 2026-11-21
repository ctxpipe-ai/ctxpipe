import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The surface for a panel that floats over the knowledge graph canvas, such as
 * the tips callout or the selection inspector. Give it a `role` and `ariaLabel`
 * when it acts as a dialog or region.
 */
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
      className={cn("rounded-md border border-border bg-zinc-900", className)}
      {...(role ? { role } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    >
      {children}
    </div>
  )
}

/**
 * The small section label inside a `FloatingPanel`.
 */
export function PanelLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p className={cn("ctx-label text-muted-foreground", className)}>
      {children}
    </p>
  )
}
