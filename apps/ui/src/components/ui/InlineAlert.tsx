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

/** The icon color of an alert without a frame: the one color of the alert. */
const plainIconClass: Record<InlineAlertVariant, string> = {
  error: "text-red-400",
  warning: "text-amber-300",
  success: "text-teal-300",
}

export function InlineAlert({
  variant,
  title,
  children,
  actions,
  actionsPlacement = "below",
  framed = true,
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
  /**
   * `false`: no frame and no surface, only the colored icon, the text and the
   * actions. Use it inside a block that already shows the problem (a settings
   * card with the amber edge), so that the block has one warning signal.
   */
  framed?: boolean
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
      <div
        className={`text-sm leading-snug ${
          framed ? "opacity-95" : title ? "text-muted-foreground" : ""
        }`}
      >
        {children}
      </div>
    </>
  )

  return (
    <div
      role="alert"
      // A long URL or id wraps inside the slab.
      className={`flex gap-3 wrap-anywhere ${
        framed
          ? `rounded-md border p-3 ${variantClass[variant]}`
          : "text-foreground"
      }`}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${
          !framed
            ? plainIconClass[variant]
            : variant === "warning"
              ? "text-amber-300"
              : "opacity-90"
        }`}
        aria-hidden
      />
      {actionsPlacement === "end" ? (
        // Without a frame, the text starts on the line of the icon.
        <div
          className={`flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-3 ${
            framed ? "items-center" : "items-start"
          }`}
        >
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
