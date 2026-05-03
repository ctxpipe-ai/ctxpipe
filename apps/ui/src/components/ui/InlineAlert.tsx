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
}: {
  variant: InlineAlertVariant
  title?: string
  children: ReactNode
  actions?: ReactNode
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
      className={`flex gap-3 rounded-lg border p-3 ${variantClass[variant]}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0 opacity-90" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        {title ? <p className="text-sm font-medium">{title}</p> : null}
        <div className="text-sm leading-snug opacity-95">{children}</div>
        {actions ? (
          <div className="flex flex-wrap gap-2 pt-0.5">{actions}</div>
        ) : null}
      </div>
    </div>
  )
}
