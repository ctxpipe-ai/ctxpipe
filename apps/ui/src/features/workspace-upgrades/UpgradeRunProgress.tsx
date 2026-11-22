import { ProgressBar } from "react-aria-components"

import { useNow } from "@/lib/useNow"

import { formatElapsed, type UpgradeProgress } from "./upgrade-progress"

/**
 * The progress of an upgrade that ctxpipe works on: what it does now, how far it
 * is, and the time so far. The bar is a full-width bar that scales, so the
 * layout does not move. It pulses when the server gives no count.
 */
export function UpgradeRunProgress(props: {
  title: string
  progress: UpgradeProgress
  /** A list of several runs says this one time, not on each run. */
  hideLeaveHint?: boolean
}) {
  const { progress } = props
  const now = useNow(progress.since !== null)
  return (
    <section
      className="mt-3 flex flex-col gap-2 rounded-md bg-white/[0.03] px-3 py-2"
      aria-label={`Progress of ${props.title}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <p className="text-foreground">{progress.label}</p>
        {progress.count ? (
          <p className="text-muted-foreground tabular-nums">{progress.count}</p>
        ) : null}
      </div>
      <ProgressBar
        aria-label={progress.label}
        {...(progress.fraction === null
          ? { isIndeterminate: true }
          : { value: progress.fraction * 100 })}
        className="h-1 w-full overflow-hidden rounded-full bg-zinc-800"
      >
        {progress.fraction === null ? (
          <div className="ctx-loading-motion h-full w-full animate-pulse rounded-full bg-teal-400/50" />
        ) : (
          <div
            className="h-full w-full origin-left rounded-full bg-teal-400 transition-[scale] duration-100"
            style={{ scale: `${progress.fraction} 1` }}
          />
        )}
      </ProgressBar>
      {progress.detail ? (
        <p className="text-xs break-words text-muted-foreground">
          {progress.detail}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {progress.since ? (
          <>
            Time so far:{" "}
            <span className="tabular-nums">
              {formatElapsed(progress.since, now)}
            </span>
            .{" "}
          </>
        ) : null}
        {props.hideLeaveHint
          ? null
          : "You can leave this page. The work continues, and this card shows its state when you come back."}
      </p>
    </section>
  )
}
