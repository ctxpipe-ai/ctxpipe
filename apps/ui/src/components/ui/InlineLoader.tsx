import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Shared teal loader visual vocabulary used across async-fetch and long-
 * running-simulation surfaces:
 *
 *   <pulsing teal 2×2 dot> <uppercase tracked teal label>
 *   <───── teal bar on dark track ─────>
 *   <optional tabular-nums sublabel>
 *
 * Two exports:
 *   - `InlineLoader`    — indeterminate sliding bar for fetches with no ETA.
 *   - `ProgressLoader`  — determinate bar driven by `progress` (0–100).
 *
 * Both self-center within their parent via `mx-auto w-fit`, so callers rarely
 * need wrapper flexboxes.
 */

function LoaderShell({
  label,
  sublabel,
  children,
  className,
}: {
  label: string
  sublabel?: string
  children: ReactNode
  className?: string
}) {
  return (
    <output
      className={cn(
        "mx-auto flex w-fit flex-col items-center gap-2 py-2 text-center",
        className,
      )}
    >
      <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.24em] text-teal-400">
        <span
          aria-hidden
          className="inline-block h-2 w-2 animate-pulse bg-teal-400"
        />
        <span>{label}</span>
      </div>
      {children}
      {sublabel ? (
        <p className="text-[12px] tabular-nums text-zinc-500">{sublabel}</p>
      ) : null}
    </output>
  )
}

export function InlineLoader({
  label,
  sublabel,
  className,
}: {
  /** Uppercase caption next to the pulse dot (e.g. "Loading repositories"). */
  label: string
  /** Optional lighter-weight line underneath (e.g. "3 repos · 2 agents"). */
  sublabel?: string
  className?: string
}) {
  return (
    <LoaderShell label={label} sublabel={sublabel} className={className}>
      <div
        aria-hidden
        className="relative h-1 w-56 overflow-hidden bg-zinc-900/80"
      >
        <span className="inline-loader-indeterminate absolute inset-y-0 w-1/3 bg-teal-400" />
      </div>
    </LoaderShell>
  )
}

export function ProgressLoader({
  label,
  sublabel,
  progress,
  className,
}: {
  label: string
  sublabel?: string
  /** 0–100. Caller is responsible for any clamping (e.g. capping at 99 so
   * the bar never reads as "done" before the consumer's reveal fires). */
  progress: number
  className?: string
}) {
  const clamped = Math.min(100, Math.max(0, progress))
  return (
    <LoaderShell label={label} sublabel={sublabel} className={className}>
      <div aria-hidden className="h-1 w-56 overflow-hidden bg-zinc-900/80">
        <div
          className="h-full bg-teal-400 transition-[width] duration-150 ease-linear"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </LoaderShell>
  )
}
