import { IconAffiliate, IconRefresh } from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

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

/* Shared button shape — matches the "Connect a repository" Link so both CTAs
 * have equal visual weight in the centred empty state. */
const ACTION_BUTTON_CLASS =
  "inline-flex min-w-[180px] items-center justify-center gap-2 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-200 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-50 disabled:opacity-50"

const FEEDBACK_VISIBLE_MS = 4000

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
  const [feedback, setFeedback] = useState<"checked" | null>(null)
  const wasFetchingRef = useRef(false)

  /* Flash a "Checked just now" status each time a refresh round-trip completes
   * so the user knows the click did something, even when the data still looks
   * the same. */
  useEffect(() => {
    if (wasFetchingRef.current && !isFetching) {
      setFeedback("checked")
      const t = setTimeout(() => setFeedback(null), FEEDBACK_VISIBLE_MS)
      return () => clearTimeout(t)
    }
    wasFetchingRef.current = isFetching
  }, [isFetching])

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
        <div className="flex flex-col items-center gap-2 pt-1">
          {reason === "no-repos" ? (
            <Link
              to="/$orgSlug/repositories"
              params={{ orgSlug }}
              className={ACTION_BUTTON_CLASS}
            >
              Connect a repository
            </Link>
          ) : (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isFetching}
              aria-live="polite"
              className={ACTION_BUTTON_CLASS}
            >
              <IconRefresh
                className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
                aria-hidden
              />
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
          )}
          {/* Persistent-height slot so the button doesn't jump when the
           * feedback line appears and disappears. */}
          <p
            aria-live="polite"
            className={cn(
              "h-3.5 text-[10px] leading-none tabular-nums transition-opacity duration-200",
              feedback ? "opacity-100 text-zinc-400" : "opacity-0",
            )}
          >
            {feedback === "checked"
              ? reason === "indexing"
                ? "Checked just now — still indexing."
                : "Checked just now — no new data yet."
              : "\u00A0"}
          </p>
        </div>
      </div>
    </div>
  )
}
