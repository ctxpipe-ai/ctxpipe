import type { ReactNode } from "react"

import { hideSecrets } from "@/lib/hide-secrets"
import { cn } from "@/lib/utils"

/**
 * Raw machine detail (a server reason, a fallback link) in a small mono block
 * with a capped height that scrolls (DESIGN.md). A string child goes through
 * `hideSecrets`, so a signed URL or a token never shows in full. A caller
 * that passes elements removes the secrets from their text itself.
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
      {typeof props.children === "string"
        ? hideSecrets(props.children)
        : props.children}
    </p>
  )
}
