/**
 * PROTOTYPE (settings variant D, branch `prototype/workspace-settings`). The
 * Status cell of a source row with its live work: the connection or index
 * state, then what ctxpipe does with the source now and for how long.
 */
import type { ReactNode } from "react"

import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { useNow } from "@/lib/useNow"

/** The live work of one source. */
export type SourceLiveStatus = {
  /** A short word for the work, for example "Syncing" or "Reading the code". */
  label: string
  /** For example "6 runs: 1 publishing, 4 reading the code, 1 waiting". */
  detail: string | null
  /** The start of the oldest run. */
  since: string
}

/** Finds the live work of a GitHub repository row or of a provider group. */
export type SourceLiveStatusLookup = {
  repository: (title: string) => SourceLiveStatus | null
  provider: (provider: string) => SourceLiveStatus | null
}

/** The wider Status column, for the state and the live work. */
export const liveSourceGridClassName =
  "@3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_15rem_4.5rem]"

export function SourceLiveStatusCell(props: {
  state: ReactNode
  live: SourceLiveStatus | null
}) {
  const { live } = props
  const now = useNow(live !== null)
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {props.state}
      {live ? (
        <span
          className="inline-flex max-w-full items-center gap-1.5 text-xs text-teal-200"
          title={live.detail ?? undefined}
        >
          <span
            aria-hidden
            className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400"
          />
          <span className="truncate">{live.label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            · {formatElapsed(live.since, now)}
          </span>
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Idle</span>
      )}
      {live?.detail ? (
        <span className="max-w-full text-xs text-muted-foreground">
          {live.detail}
        </span>
      ) : null}
    </div>
  )
}
