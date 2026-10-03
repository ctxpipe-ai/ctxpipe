import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

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
        "rounded-md border border-border bg-zinc-900/95",
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
    <p className={cn("ctx-label text-muted-foreground", className)}>
      {children}
    </p>
  )
}
