"use client"

import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
} from "lucide-react"
import type { ReactNode } from "react"

type InlineAlertVariant = "error" | "warning" | "success"

const variantClass: Record<InlineAlertVariant, string> = {
  error: "border-red-500/40 bg-red-950/35 text-red-50",
  // A dark surface with a yellow border and a yellow icon (product owner,
  // 2026-11-14). A banner and an inline warning use this one look.
  warning: "border-amber-300 bg-zinc-900 text-zinc-50",
  success: "border-teal-500/40 bg-teal-950/25 text-teal-50",
}

export function InlineAlert({
  variant,
  title,
  children,
  actions,
  actionsPlacement = "below",
}: {
  variant: InlineAlertVariant
  title?: string
  children: ReactNode
  actions?: ReactNode
  /**
   * `end`: the actions sit on the right of the slab, beside the text, and
   * wrap below it only when the slab is narrow. The default is below.
   */
  actionsPlacement?: "below" | "end"
}) {
  const Icon =
    variant === "error"
      ? AlertCircleIcon
      : variant === "success"
        ? CheckCircle2Icon
        : AlertTriangleIcon

  const text = (
    <>
      {title ? <p className="text-sm font-medium">{title}</p> : null}
      <div className="text-sm leading-snug opacity-95">{children}</div>
    </>
  )

  return (
    <div
      role="alert"
      // A long URL or id wraps inside the slab.
      className={`flex gap-3 rounded-md border p-3 wrap-anywhere ${variantClass[variant]}`}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${
          variant === "warning" ? "text-amber-300" : "opacity-90"
        }`}
        aria-hidden
      />
      {actionsPlacement === "end" ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-64 space-y-2">{text}</div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
          ) : null}
        </div>
      ) : (
        <div className="min-w-0 flex-1 space-y-2">
          {text}
          {actions ? (
            <div className="flex flex-wrap gap-2 pt-0.5">{actions}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}
