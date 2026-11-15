import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * Raw machine detail (a server reason, a fallback link) in a small mono block
 * with a capped height that scrolls (DESIGN.md). The caller removes the
 * secret-like values with `hideSecrets` first.
 */
export function TechnicalDetail(props: {
  children: ReactNode
  /** `error` sits inside an error alert; `muted` sits on a neutral surface. */
  tone?: "error" | "muted"
  className?: string
}) {
  return (
    <p
      className={cn(
        "max-h-24 overflow-y-auto rounded-md px-2 py-1.5 font-mono text-xs wrap-anywhere",
        props.tone === "error"
          ? "bg-red-950/60 text-red-100"
          : "bg-zinc-950/60 text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </p>
  )
}
