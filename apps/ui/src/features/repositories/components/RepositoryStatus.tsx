import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import type { RepositoryIndexingStatus } from "../types"

export type RepositoryStatusState =
  | RepositoryIndexingStatus
  | "pending-indexing"

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
  failed: {
    label: "indexing failed",
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
  /** Extra copy when status is `running` (e.g. merge vs push). */
  indexingDetail?: string | null
  /** Error details shown in a tooltip when status is `failed`. */
  failedDetail?: string | null
  className?: string
}) {
  const meta = STATUS_META[props.status]
  const label =
    props.status === "running" && props.indexingDetail?.trim()
      ? props.indexingDetail.trim()
      : meta.label
  const failedDetail =
    props.status === "failed" ? props.failedDetail?.trim() : null
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

  if (!failedDetail) return statusBadge

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger>{statusBadge}</TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[min(24rem,calc(100vw-2rem))] wrap-break-word"
        >
          <p>{failedDetail}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
