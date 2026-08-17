import type { ReactNode } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { formatDate } from "@/lib/format"
import { formatShortCommitHash, type RepositoryStatusDisplay } from "../types"

export type RepositoryStatusState = RepositoryStatusDisplay | "pending-indexing"

const STATUS_META: Record<
  RepositoryStatusState,
  { label: string; className: string; dotClassName: string }
> = {
  ready: {
    label: "indexed",
    className: "ctx-indexed",
    dotClassName: "ctx-indexed-dot",
  },
  queued: {
    label: "queued",
    className: "ctx-pending-indexing",
    dotClassName: "ctx-pending-indexing-dot",
  },
  running: {
    label: "indexing",
    className: "ctx-indexing",
    dotClassName: "ctx-indexing-dot",
  },
  refreshing: {
    label: "refreshing",
    className: "ctx-indexing",
    dotClassName: "ctx-indexing-dot",
  },
  failed: {
    label: "indexing failed",
    className: "ctx-indexing-failed",
    dotClassName: "ctx-indexing-failed-dot",
  },
  "out-of-date": {
    label: "out of date",
    className: "ctx-indexing-failed",
    dotClassName: "ctx-indexing-failed-dot",
  },
  "pending-indexing": {
    label: "pending indexing",
    className: "ctx-pending-indexing",
    dotClassName: "ctx-pending-indexing-dot",
  },
  unindexing: {
    label: "unindexing",
    className: "ctx-unindexing",
    dotClassName: "ctx-unindexing-dot",
  },
}

export function RepositoryStatus(props: {
  status: RepositoryStatusState
  /** Extra copy for active indexing states (step label or reason fallback). */
  indexingDetail?: string | null
  /** Error details shown in a tooltip when status is `failed`. */
  failedDetail?: string | null
  /** Last successful ingest time, shown on `ready` as `indexed · 1 hour ago`. */
  indexedAt?: string | null
  /** Prior-success + error details for `out-of-date` tooltip. */
  outOfDateDetail?: {
    lastIngestedHash: string
    lastIngestedAt?: string | null
    indexingError?: string | null
  } | null
  className?: string
  /** Skip tooltip chrome (virtualised lists while scrolling). */
  interactive?: boolean
}) {
  const meta = STATUS_META[props.status]
  const canShowIndexingDetail =
    props.status === "queued" ||
    props.status === "running" ||
    props.status === "refreshing"
  const relativeIndexed =
    props.status === "ready" && props.indexedAt
      ? formatDate(props.indexedAt)
      : null
  const label =
    canShowIndexingDetail && props.indexingDetail?.trim()
      ? props.indexingDetail.trim()
      : relativeIndexed
        ? `${meta.label} · ${relativeIndexed}`
        : meta.label

  const tooltipContent =
    props.interactive === false ? null : resolveTooltipContent(props)

  const statusBadge = (
    <span
      className={
        props.className
          ? `${meta.className} ${props.className}`
          : meta.className
      }
    >
      <span aria-hidden className={meta.dotClassName} />
      {label}
    </span>
  )

  if (!tooltipContent) return statusBadge

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger>{statusBadge}</TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[min(24rem,calc(100vw-2rem))] wrap-break-word"
        >
          {tooltipContent}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function resolveTooltipContent(props: {
  status: RepositoryStatusState
  indexedAt?: string | null
  failedDetail?: string | null
  outOfDateDetail?: {
    lastIngestedHash: string
    lastIngestedAt?: string | null
    indexingError?: string | null
  } | null
}): ReactNode {
  if (props.status === "ready" && props.indexedAt) {
    return (
      <p>
        Last indexed{" "}
        {new Date(props.indexedAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </p>
    )
  }
  if (props.status === "out-of-date" && props.outOfDateDetail) {
    const shortHash = formatShortCommitHash(
      props.outOfDateDetail.lastIngestedHash,
    )
    const relativeTime = props.outOfDateDetail.lastIngestedAt
      ? formatDate(props.outOfDateDetail.lastIngestedAt)
      : null
    const error = props.outOfDateDetail.indexingError?.trim() || null

    return (
      <div className="space-y-1.5 text-left">
        <p>
          Last success:{" "}
          <code className="rounded-sm bg-background/15 px-1 py-0.5 font-mono text-[0.7rem]">
            {shortHash}
          </code>
          {relativeTime ? ` ${relativeTime}` : null}
        </p>
        {error ? (
          <p>
            <strong className="font-semibold">Error</strong>: {error}
          </p>
        ) : null}
      </div>
    )
  }

  if (props.status === "failed") {
    const failedDetail = props.failedDetail?.trim()
    return failedDetail ? <p>{failedDetail}</p> : null
  }

  return null
}
