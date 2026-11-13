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
  warning: "border-amber-500/45 bg-amber-950/30 text-amber-50",
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
      : variant === "warning"
        ? AlertTriangleIcon
        : CheckCircle2Icon

  return (
    <div
      role="alert"
      className={`flex gap-3 rounded-md border p-3 ${variantClass[variant]}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0 opacity-90" aria-hidden />
      <div
        className={
          actionsPlacement === "end"
            ? "flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-3"
            : "min-w-0 flex-1 space-y-2"
        }
      >
        <div
          className={
            actionsPlacement === "end"
              ? "min-w-0 flex-1 basis-64 space-y-2"
              : "contents"
          }
        >
          {title ? <p className="text-sm font-medium">{title}</p> : null}
          <div className="text-sm leading-snug opacity-95">{children}</div>
        </div>
        {actions ? (
          <div
            className={
              actionsPlacement === "end"
                ? "flex shrink-0 flex-wrap gap-2"
                : "flex flex-wrap gap-2 pt-0.5"
            }
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  )
}
