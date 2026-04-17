import { IconAffiliate, IconRefresh } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"

export type EmptyReason = "no-repos" | "indexing" | "no-claims"

const COPY: Record<
  EmptyReason,
  { title: string; body: string; hint?: string }
> = {
  "no-repos": {
    title: "No graph yet",
    body: "Your knowledge graph is built from the repositories ctx| has ingested. Connect one to get started.",
  },
  indexing: {
    title: "Indexing your repositories…",
    body: "ctx| is scanning your codebase. The graph will fill in as concepts and their relationships are extracted.",
    hint: "This usually takes a few minutes on first ingest.",
  },
  "no-claims": {
    title: "Building graph…",
    body: "Indexing finished. We're extracting relationships between concepts now — nodes and edges will appear as claims are projected.",
    hint: "Refresh in a minute or two.",
  },
}

export function KnowledgeGraphEmpty({
  reason,
  orgSlug,
  isFetching,
  onRefresh,
}: {
  reason: EmptyReason
  orgSlug: string
  isFetching: boolean
  onRefresh: () => void
}) {
  const copy = COPY[reason]
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <span
          className="flex h-14 w-14 items-center justify-center border border-zinc-800/95 bg-zinc-950/60 text-teal-400/80"
          aria-hidden
        >
          <IconAffiliate className="h-7 w-7" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.22em] text-teal-400">
            {copy.title}
          </h2>
          <p className="text-[13px] leading-snug text-zinc-300">{copy.body}</p>
          {copy.hint ? (
            <p className="text-[11px] leading-snug text-zinc-500">
              {copy.hint}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 pt-1">
          {reason === "no-repos" ? (
            <Link
              to="/$orgSlug/repositories"
              params={{ orgSlug }}
              className="inline-flex items-center gap-1.5 rounded-none border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-teal-300 transition-colors hover:border-teal-400/60 hover:bg-teal-500/15 hover:text-teal-200"
            >
              Connect a repository
            </Link>
          ) : (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-50"
            >
              <IconRefresh
                className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
                aria-hidden
              />
              Refresh
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
