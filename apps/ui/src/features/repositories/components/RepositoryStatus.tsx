export type RepositoryStatusState =
  | "indexed"
  | "indexing"
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
  className?: string
}) {
  const meta = STATUS_META[props.status]

  return (
    <span className={props.className ? `${meta.className} ${props.className}` : meta.className}>
      <span aria-hidden className={meta.dotClassName} />
      {meta.label}
    </span>
  )
}
