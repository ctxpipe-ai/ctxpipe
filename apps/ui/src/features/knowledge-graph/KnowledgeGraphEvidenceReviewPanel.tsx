import {
  IconAlertTriangle,
  IconArrowRight,
  IconExternalLink,
  IconRefresh,
  IconX,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { client } from "@/lib/api"
import type { KnowledgeGraphReviewPayload } from "./types"

type ReviewItem = KnowledgeGraphReviewPayload["items"][number]
type ReviewObject = ReviewItem["subject"]

type KnowledgeGraphEvidenceReviewPanelProps = {
  orgSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onNodeSelect: (id: string) => void
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d)
}

function labelForObject(object: ReviewObject): string {
  return object.name?.trim() || object.id
}

function sourceTarget(href: string): "_blank" | undefined {
  return href.startsWith("http://") || href.startsWith("https://")
    ? "_blank"
    : undefined
}

function ObjectPill({
  object,
  onSelect,
}: {
  object: ReviewObject
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(object.id)}
      className="group min-w-0 border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-left transition-colors hover:border-teal-500/70"
      title="Focus this node"
    >
      <span className="block truncate text-[12px] font-medium text-zinc-100 group-hover:text-teal-200">
        {labelForObject(object)}
      </span>
      <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
        {object.kind}
      </span>
    </button>
  )
}

function ReviewItemCard({
  item,
  onNodeSelect,
}: {
  item: ReviewItem
  onNodeSelect: (id: string) => void
}) {
  return (
    <article className="border border-zinc-800/95 bg-zinc-950/92 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-teal-400">
            {item.predicate}
          </p>
          <p className="mt-1 text-[12px] text-zinc-500">
            Last observed {formatDate(item.lastObservedAt)}
          </p>
        </div>
        <span className="shrink-0 border border-amber-500/40 bg-amber-950/35 px-2 py-1 text-[12px] font-medium text-amber-200">
          {percent(item.aggregatedConfidence)}
        </span>
      </div>

      <div className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)] items-center gap-2">
        <ObjectPill object={item.subject} onSelect={onNodeSelect} />
        <IconArrowRight className="size-4 text-zinc-600" aria-hidden />
        <ObjectPill object={item.object} onSelect={onNodeSelect} />
      </div>

      {item.evidence.length > 0 ? (
        <div className="mt-3 space-y-2">
          {item.evidence.map((evidence) => (
            <a
              key={evidence.id}
              href={evidence.sourceLink}
              target={sourceTarget(evidence.sourceLink)}
              rel={
                sourceTarget(evidence.sourceLink)
                  ? "noreferrer noopener"
                  : undefined
              }
              className="block border border-zinc-900/95 bg-black/25 px-2 py-2 transition-colors hover:border-zinc-700"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[12px] text-zinc-300">
                  {evidence.sourceType} · {evidence.extractionMethod}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-500">
                  {percent(evidence.confidence)}
                  <IconExternalLink className="size-3" aria-hidden />
                </span>
              </span>
              <span className="mt-1 block truncate font-mono text-[11px] text-zinc-600">
                {evidence.sourceId}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p className="mt-3 border border-zinc-900/95 bg-black/25 px-2 py-2 text-[12px] text-zinc-500">
          No evidence rows are attached to this claim.
        </p>
      )}
    </article>
  )
}

export function KnowledgeGraphEvidenceReviewPanel({
  orgSlug,
  open,
  onOpenChange,
  onNodeSelect,
}: KnowledgeGraphEvidenceReviewPanelProps) {
  const { data, error, isFetching, isPending, refetch } = useQuery({
    queryKey: ["knowledge-graph-review", orgSlug],
    queryFn: async (): Promise<KnowledgeGraphReviewPayload> => {
      const res = await client[":orgSlug"].api.v1[
        "knowledge-graph"
      ].review.$get({
        param: { orgSlug },
        query: { confidenceBelow: "0.7", limit: "50" },
      })
      if (!res.ok) {
        throw new Error(`Knowledge graph review failed: ${res.status}`)
      }
      return res.json()
    },
    staleTime: 30_000,
  })

  const total = data?.total ?? 0
  const totalLabel =
    data == null
      ? "Loading low-confidence context claims"
      : `${total.toLocaleString()} low-confidence context claims`

  if (!open) {
    return total > 0 ? (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="absolute right-4 top-4 z-30 flex max-w-[calc(100vw-2rem)] items-center gap-2 border border-amber-500/35 bg-zinc-950/90 px-3 py-2 text-[12px] font-medium text-amber-100 shadow-xl shadow-black/35 backdrop-blur transition-colors hover:border-amber-300/60"
      >
        <IconAlertTriangle className="size-4" aria-hidden />
        <span>{total.toLocaleString()} claims need review</span>
      </button>
    ) : null
  }

  return (
    <aside className="absolute bottom-4 right-4 top-4 z-40 flex w-[min(36rem,calc(100vw-2rem))] flex-col border border-zinc-800/95 bg-zinc-950/95 shadow-2xl shadow-black/45 backdrop-blur-md">
      <div className="flex items-start justify-between gap-3 border-b border-zinc-800/95 px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-mono text-[12px] uppercase tracking-[0.22em] text-teal-400">
            Evidence review
          </h2>
          <p className="mt-1 text-[13px] text-zinc-400">{totalLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex size-8 items-center justify-center border border-zinc-800 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-teal-400"
            aria-label="Refresh evidence review"
            title="Refresh evidence review"
          >
            <IconRefresh
              className={`size-4 ${isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex size-8 items-center justify-center border border-zinc-800 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200"
            aria-label="Close evidence review"
            title="Close evidence review"
          >
            <IconX className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <div className="border border-red-500/35 bg-red-950/25 px-3 py-2 text-[13px] text-red-200">
            {error instanceof Error
              ? error.message
              : "Evidence review could not be loaded."}
          </div>
        ) : null}

        {isPending && !error ? (
          <div className="border border-zinc-800/95 bg-zinc-950 px-3 py-4 text-[13px] text-zinc-500">
            Loading reviewable claims...
          </div>
        ) : null}

        {data && data.items.length === 0 && !error ? (
          <div className="border border-zinc-800/95 bg-zinc-950 px-3 py-4 text-[13px] text-zinc-500">
            No low-confidence claims are waiting for review.
          </div>
        ) : null}

        {data ? (
          <div className="space-y-3">
            {data.items.map((item) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                onNodeSelect={(id) => {
                  onOpenChange(false)
                  onNodeSelect(id)
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  )
}
