import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"

export type RepositoryStatusState =
  | "indexed"
  | "indexing"
  | "failed"
  | "pending-indexing"
  | "unindexing"

const STATUS_META: Record<
  RepositoryStatusState,
  { label: string; className: string; dotClassName: string }
> = {
  indexed: {
    label: "indexed",
    className: "ctx-indexed",
    dotClassName: "ctx-indexed-dot",
  },
  indexing: {
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
  /** Extra copy when status is `indexing` (e.g. merge vs push). */
  indexingDetail?: string | null
  /** Error details shown in a tooltip when status is `failed`. */
  failedDetail?: string | null
  className?: string
}) {
  const meta = STATUS_META[props.status]
  const label =
    props.status === "indexing" && props.indexingDetail?.trim()
      ? props.indexingDetail.trim()
      : meta.label
  const failedDetail = props.status === "failed" ? props.failedDetail?.trim() : null
  const statusBadge = (
    <span className={props.className ? `${meta.className} ${props.className}` : meta.className}>
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
