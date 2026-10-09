import { IconAffiliate } from "@tabler/icons-react"

/** Pending graph placeholder: fetch, prepare, and lay out share this one view. */
export function GraphWaitState({
  title,
  detail,
  status,
  progress,
}: {
  title: string
  detail?: string
  status: string
  /** 0–100. Omit for an indeterminate bar. */
  progress?: number
}) {
  const isDeterminate = progress != null
  const clamped = isDeterminate ? Math.min(100, Math.max(0, progress)) : 0

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
      <span className="ctx-node text-muted-foreground" aria-hidden>
        <IconAffiliate className="size-4" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="text-lg font-medium text-foreground">{title}</p>
        {detail ? (
          <p className="text-sm tabular-nums text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      <div
        aria-hidden
        className="relative h-1 w-56 overflow-hidden rounded-md bg-zinc-800"
      >
        {isDeterminate ? (
          <div
            className="h-full bg-teal-400 transition-[width] duration-150 ease-linear"
            style={{ width: `${clamped}%` }}
          />
        ) : (
          <span className="inline-loader-indeterminate absolute inset-y-0 w-1/3 bg-teal-400" />
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="ctx-indexing-dot" aria-hidden />
        {status}
      </p>
    </div>
  )
}
