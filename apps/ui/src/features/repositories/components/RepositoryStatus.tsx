export type RepositoryStatusState =
  | "indexed"
  | "indexing"
  | "failed"
  | "pending-indexing"
  | "deleting"

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
  deleting: {
    label: "deleting",
    className: "ctx-deleting",
    dotClassName: "ctx-deleting-dot",
  },
}

export function RepositoryStatus(props: {
  status: RepositoryStatusState
  /** Extra copy when status is `indexing` (e.g. merge vs push). */
  indexingDetail?: string | null
  /** Extra copy when status is `failed` (e.g. short error reason). */
  failedDetail?: string | null
  className?: string
}) {
  const meta = STATUS_META[props.status]
  const label =
    props.status === "indexing" && props.indexingDetail?.trim()
      ? props.indexingDetail.trim()
      : props.status === "failed" && props.failedDetail?.trim()
        ? props.failedDetail.trim()
      : meta.label

  return (
    <span className={props.className ? `${meta.className} ${props.className}` : meta.className}>
      <span aria-hidden className={meta.dotClassName} />
      {label}
    </span>
  )
}
