import { IconRefresh } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "react-aria-components"
import {
  KnowledgeGraphCosmographCanvas,
  type KnowledgeGraphCosmographCanvasHandle,
} from "@/features/knowledge-graph/KnowledgeGraphCosmographCanvas"
import { client } from "@/lib/api"

type KnowledgeGraphPayload = {
  metrics: {
    totalNodes: number
    totalEdges: number
    lastUpdatedAt: string | null
    nodesReturned: number
    edgesReturned: number
    truncated: boolean
  }
  nodes: Array<{
    id: string
    kind: string
    name: string | null
    summary: string | null
  }>
  edges: Array<{
    sourceId: string
    targetId: string
    predicate: string
    claimId: string | null
    lastObservedAt: string | null
  }>
}

/* Same teal/amber/violet palette vocabulary as the graph-nav branch, but assigned
 * dynamically per discovered `kind` so any FalkorDB schema picks up a colour. */
const KIND_PALETTE = [
  "#2dd4bf", // teal
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#f59e0b", // amber
  "#fb7185", // rose
  "#34d399", // emerald
  "#f472b6", // pink
  "#f97316", // orange
  "#818cf8", // indigo
  "#facc15", // yellow
] as const

/* Slate-200 at ~55% alpha: bright enough to read individual edges on the
 * zinc-950 backdrop without washing out the coloured hub nodes. */
const LINK_BASE = "rgba(226, 232, 240, 0.55)"

function hashStringToIndex(s: string, mod: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % mod
}

function buildSearchIdSet(
  nodes: KnowledgeGraphPayload["nodes"],
  q: string,
): Set<string> {
  const needle = q.trim().toLowerCase()
  if (!needle) return new Set()
  const out = new Set<string>()
  for (const n of nodes) {
    const hay = [n.id, n.kind, n.name ?? "", n.summary ?? ""]
      .join(" ")
      .toLowerCase()
    if (hay.includes(needle)) out.add(n.id)
  }
  return out
}

type KnowledgeGraphExplorerProps = {
  orgSlug: string
}

export function KnowledgeGraphExplorer({
  orgSlug,
}: KnowledgeGraphExplorerProps) {
  const [search, setSearch] = useState("")
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const cgRef = useRef<KnowledgeGraphCosmographCanvasHandle>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["knowledge-graph", orgSlug],
    queryFn: async (): Promise<KnowledgeGraphPayload> => {
      const res = await client[":orgSlug"].api.v1["knowledge-graph"].$get({
        param: { orgSlug },
      })
      if (res.status === 401) {
        throw new Error("Sign in to view the knowledge graph.")
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(err?.error ?? "Could not load the knowledge graph.")
      }
      return res.json()
    },
  })

  const sanitizedNodes = useMemo(() => {
    if (!data?.nodes) return []
    return data.nodes.filter((n) => n.id != null && String(n.id).length > 0)
  }, [data])

  const nodeIdSet = useMemo(
    () => new Set(sanitizedNodes.map((n) => String(n.id))),
    [sanitizedNodes],
  )

  /* Assign a stable palette colour to each distinct `kind` so the legend chip and the
   * rendered point share the same colour. */
  const kindColors = useMemo(() => {
    const map = new Map<string, string>()
    for (const n of sanitizedNodes) {
      const k = n.kind || "Unknown"
      if (!map.has(k)) {
        const idx = hashStringToIndex(k, KIND_PALETTE.length)
        map.set(k, KIND_PALETTE[idx] ?? "#71717a")
      }
    }
    return map
  }, [sanitizedNodes])

  const allKinds = useMemo(
    () => Array.from(kindColors.keys()).sort(),
    [kindColors],
  )

  const nodeById = useMemo(() => {
    const m = new Map<string, KnowledgeGraphPayload["nodes"][number]>()
    for (const n of sanitizedNodes) m.set(String(n.id), n)
    return m
  }, [sanitizedNodes])

  /* Per-node stats (degree split, predicate frequencies, activity window, distinct
   * claims, neighbour kinds) are computed once per dataset and looked up by id from
   * the detail drawer. */
  type NodeFacts = {
    inDegree: number
    outDegree: number
    predicateCounts: Map<string, number>
    claimIds: Set<string>
    firstObserved: number | null
    lastObserved: number | null
    neighbourKindCounts: Map<string, number>
  }
  const nodeFacts = useMemo(() => {
    const facts = new Map<string, NodeFacts>()
    const ensure = (id: string): NodeFacts => {
      let f = facts.get(id)
      if (!f) {
        f = {
          inDegree: 0,
          outDegree: 0,
          predicateCounts: new Map(),
          claimIds: new Set(),
          firstObserved: null,
          lastObserved: null,
          neighbourKindCounts: new Map(),
        }
        facts.set(id, f)
      }
      return f
    }
    if (!data) return facts
    for (const e of data.edges) {
      if (e.sourceId == null || e.targetId == null) continue
      const s = String(e.sourceId)
      const t = String(e.targetId)
      if (!nodeIdSet.has(s) || !nodeIdSet.has(t)) continue
      const src = ensure(s)
      const tgt = ensure(t)
      src.outDegree++
      tgt.inDegree++
      const pred = e.predicate || "—"
      src.predicateCounts.set(pred, (src.predicateCounts.get(pred) ?? 0) + 1)
      tgt.predicateCounts.set(pred, (tgt.predicateCounts.get(pred) ?? 0) + 1)
      if (e.claimId) {
        src.claimIds.add(e.claimId)
        tgt.claimIds.add(e.claimId)
      }
      if (e.lastObservedAt) {
        const ts = Date.parse(e.lastObservedAt)
        if (Number.isFinite(ts)) {
          for (const f of [src, tgt]) {
            f.firstObserved =
              f.firstObserved == null ? ts : Math.min(f.firstObserved, ts)
            f.lastObserved =
              f.lastObserved == null ? ts : Math.max(f.lastObserved, ts)
          }
        }
      }
      const sKind = nodeById.get(s)?.kind || "Unknown"
      const tKind = nodeById.get(t)?.kind || "Unknown"
      src.neighbourKindCounts.set(
        tKind,
        (src.neighbourKindCounts.get(tKind) ?? 0) + 1,
      )
      tgt.neighbourKindCounts.set(
        sKind,
        (tgt.neighbourKindCounts.get(sKind) ?? 0) + 1,
      )
    }
    return facts
  }, [data, nodeIdSet, nodeById])

  const degrees = useMemo(() => {
    const d = new Map<string, number>()
    for (const [id, f] of nodeFacts) d.set(id, f.inDegree + f.outDegree)
    return d
  }, [nodeFacts])

  /* Pass the FULL node/link set to Cosmograph and drive both search and kind filters
   * through selection-based dimming. Filtering the data array instead caused the
   * simulation to restart and pan/zoom every time a kind was toggled. */
  const graphPoints = useMemo(() => {
    return sanitizedNodes.map((n) => {
      const id = String(n.id)
      const kind = n.kind || "Unknown"
      const deg = degrees.get(id) ?? 0
      return {
        id,
        label: n.name?.trim()
          ? `${n.name} (${kind})`
          : `${id.slice(0, 8)}… (${kind})`,
        color: kindColors.get(kind) ?? "#71717a",
        /* Cosmograph auto-remaps to `pointSizeRange` (3..9) so the raw value just
         * needs to be monotonic in degree — log dampens hubs. */
        size: 1 + Math.log2(deg + 1),
      }
    })
  }, [sanitizedNodes, kindColors, degrees])

  const graphLinks = useMemo(() => {
    if (!data) return []
    const out: Array<{ source: string; target: string; color: string }> = []
    for (const e of data.edges) {
      if (e.sourceId == null || e.targetId == null) continue
      const s = String(e.sourceId)
      const t = String(e.targetId)
      if (!nodeIdSet.has(s) || !nodeIdSet.has(t)) continue
      out.push({ source: s, target: t, color: LINK_BASE })
    }
    return out
  }, [data, nodeIdSet])

  /* Selection composition priority: explicit node selection beats search beats kind
   * filter beats the no-filter default (unselectAll). Selecting a single node
   * highlights its 1-hop neighbourhood via Cosmograph's built-in adjacency lookup. */
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!data) return

    /* A clicked node always wins and stays highlighted-with-neighbours while its
     * drawer is open. */
    if (selectedId) {
      cgRef.current?.selectNeighbourhood(selectedId)
      return
    }

    const q = search.trim()
    const hasSearch = q.length > 0
    const hasKindFilter = hiddenKinds.size > 0
    const anyFilter = hasSearch || hasKindFilter

    if (!anyFilter) {
      cgRef.current?.unselectAll()
      return
    }

    const apply = () => {
      const kindPool = hasKindFilter
        ? sanitizedNodes.filter((n) => !hiddenKinds.has(n.kind || "Unknown"))
        : sanitizedNodes
      const matches = hasSearch
        ? buildSearchIdSet(kindPool, q)
        : new Set(kindPool.map((n) => String(n.id)))
      if (matches.size === 0) {
        /* Nothing to show — `selectPoints([])` keeps simulation frozen but dims all. */
        cgRef.current?.selectPoints([])
        return
      }
      const ids = Array.from(matches)
      cgRef.current?.selectPoints(ids)
      if (hasSearch && ids.length <= 200) cgRef.current?.fitToIds(ids)
    }

    if (hasSearch) {
      searchDebounceRef.current = setTimeout(apply, 220)
    } else {
      apply()
    }
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [search, hiddenKinds, sanitizedNodes, data, selectedId])

  const onPointClick = useCallback((id: string | null) => {
    setSelectedId(id)
  }, [])

  const onBackgroundClick = useCallback(() => {
    setSelectedId(null)
    cgRef.current?.unselectAll()
  }, [])

  const toggleKind = useCallback((kind: string) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }, [])

  /* Escape closes the detail drawer. */
  useEffect(() => {
    if (!selectedId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedId(null)
        cgRef.current?.unselectAll()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedId])

  /* Keep the last-displayed node mounted during the slide-out animation so the
   * drawer doesn't pop / go blank before translating off-screen. */
  const [displayedId, setDisplayedId] = useState<string | null>(null)
  useEffect(() => {
    if (selectedId) {
      setDisplayedId(selectedId)
      return
    }
    const t = setTimeout(() => setDisplayedId(null), 220)
    return () => clearTimeout(t)
  }, [selectedId])

  const displayedNode = displayedId ? (nodeById.get(displayedId) ?? null) : null
  const displayedFacts = displayedId
    ? (nodeFacts.get(displayedId) ?? null)
    : null
  const drawerOpen = Boolean(selectedId && displayedNode)

  const showGraph = Boolean(data && !error && graphPoints.length > 0)
  const searchMatchCount = useMemo(() => {
    if (!data || !search.trim()) return null
    const pool =
      hiddenKinds.size > 0
        ? sanitizedNodes.filter((n) => !hiddenKinds.has(n.kind || "Unknown"))
        : sanitizedNodes
    return buildSearchIdSet(pool, search).size
  }, [data, search, sanitizedNodes, hiddenKinds])

  /* Weekly histogram of edge activity from `lastObservedAt`. `null` timestamps are
   * skipped — some older projections may not carry them. Returns a compact fixed
   * number of buckets aligned to ISO weeks so the sparkline stays the same width
   * regardless of dataset age. */
  const activityBuckets = useMemo(() => {
    if (!data) return null
    const stamps: number[] = []
    for (const e of data.edges) {
      if (!e.lastObservedAt) continue
      const t = Date.parse(e.lastObservedAt)
      if (!Number.isFinite(t)) continue
      stamps.push(t)
    }
    if (stamps.length === 0) return null
    const min = Math.min(...stamps)
    const max = Math.max(...stamps)
    const WEEK = 7 * 24 * 60 * 60 * 1000
    const span = Math.max(max - min, WEEK)
    /* Cap at 24 buckets for a short sparkline; width scales with span. */
    const bucketCount = Math.min(24, Math.max(6, Math.ceil(span / WEEK)))
    const bucketSize = span / bucketCount
    const counts = new Array<number>(bucketCount).fill(0)
    for (const t of stamps) {
      const idx = Math.min(bucketCount - 1, Math.floor((t - min) / bucketSize))
      counts[idx] = (counts[idx] ?? 0) + 1
    }
    return {
      counts,
      rangeStart: min,
      rangeEnd: max,
      total: stamps.length,
    }
  }, [data])

  return (
    <div className="relative z-10 h-[100dvh] min-h-[100dvh] w-full shrink-0">
      {showGraph ? (
        <div className="absolute inset-0 z-0 h-full w-full min-h-0">
          <KnowledgeGraphCosmographCanvas
            ref={cgRef}
            points={graphPoints}
            links={graphLinks}
            onPointClick={onPointClick}
            onBackgroundClick={onBackgroundClick}
          />
        </div>
      ) : null}

      {/* Top-left: title + metrics */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-3">
        <h1 className="font-mono text-[10px] uppercase tracking-[0.24em] text-teal-400 drop-shadow-[0_1px_8px_rgba(0,0,0,0.85)]">
          Knowledge graph
        </h1>
        {data?.metrics ? (
          <div className="pointer-events-auto flex gap-2">
            <MetricChip label="Nodes" value={data.metrics.totalNodes} />
            <MetricChip label="Edges" value={data.metrics.totalEdges} />
          </div>
        ) : null}
      </div>

      {/* Top-center: search */}
      <div className="pointer-events-auto absolute left-1/2 top-4 z-10 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur-md focus-within:border-teal-500/55">
          <svg
            className="h-3.5 w-3.5 shrink-0 text-zinc-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden
          >
            <title>Search</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 1 0 6.5 6.5a7.5 7.5 0 0 0 10.15 10.15z"
            />
          </svg>
          <label htmlFor="kg-search" className="sr-only">
            Search
          </label>
          <input
            id="kg-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("")
            }}
            placeholder="Search nodes, kinds, summaries…"
            className="w-72 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {search.trim() ? (
            <div className="flex shrink-0 items-center gap-2 border-l border-zinc-800/95 pl-2">
              <span className="text-[10px] tabular-nums text-zinc-400">
                {searchMatchCount === null
                  ? "…"
                  : `${searchMatchCount.toLocaleString()} match${
                      searchMatchCount === 1 ? "" : "es"
                    }`}
              </span>
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="text-zinc-500 transition-colors hover:text-zinc-200"
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  aria-hidden
                >
                  <title>Clear search</title>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Top-right cluster: activity sparkline + kind legend, side-by-side so they
       * both sit between the centered search and the screen edge. Hidden while the
       * node-detail drawer is open so the drawer has the full right rail. */}
      <div
        className="pointer-events-auto absolute right-4 top-4 z-10 flex items-start gap-3 transition-opacity duration-200"
        style={{
          opacity: drawerOpen ? 0 : 1,
          pointerEvents: drawerOpen ? "none" : "auto",
        }}
      >
        {activityBuckets ? (
          <ActivitySparkline
            buckets={activityBuckets.counts}
            rangeStart={activityBuckets.rangeStart}
            rangeEnd={activityBuckets.rangeEnd}
            total={activityBuckets.total}
          />
        ) : null}
        {allKinds.length > 0 ? (
          <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto rounded-none border border-zinc-800/95 bg-zinc-950/90 p-3 shadow-xl shadow-black/40 backdrop-blur-md">
            <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Node kinds
            </p>
            {allKinds.map((kind) => {
              const isHidden = hiddenKinds.has(kind)
              const color = kindColors.get(kind) ?? "#71717a"
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleKind(kind)}
                  className={`flex items-center gap-2 rounded-none px-1 py-0.5 text-left transition-opacity hover:bg-white/5 ${isHidden ? "opacity-35" : ""}`}
                  aria-pressed={!isHidden}
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0"
                    style={{ backgroundColor: isHidden ? "#52525b" : color }}
                  />
                  <span
                    className={`text-[11px] ${isHidden ? "text-zinc-600 line-through" : "text-zinc-300"}`}
                  >
                    {kind}
                  </span>
                </button>
              )
            })}
            {hiddenKinds.size > 0 ? (
              <button
                type="button"
                onClick={() => setHiddenKinds(new Set())}
                className="mt-1.5 text-left text-[10px] text-teal-400 hover:text-teal-300"
              >
                Show all
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Bottom-right: map controls */}
      <div className="pointer-events-auto absolute bottom-4 right-4 z-10 flex flex-col gap-1">
        <MapControlButton onClick={() => void refetch()} label="Refresh graph">
          <IconRefresh
            className={`h-3.5 w-3.5${isFetching ? " animate-spin" : ""}`}
            aria-hidden
          />
        </MapControlButton>
        <MapControlButton
          onClick={() => cgRef.current?.fitView?.()}
          label="Fit view"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden
          >
            <title>Fit view</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
            />
          </svg>
        </MapControlButton>
      </div>

      {/* Truncation notice */}
      {data?.metrics.lastUpdatedAt || data?.metrics.truncated ? (
        <div className="pointer-events-auto absolute bottom-4 left-4 z-10 flex flex-col gap-0.5 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-3 py-2 text-[10px] leading-tight text-zinc-500 shadow-xl shadow-black/40 backdrop-blur-md">
          {data?.metrics.lastUpdatedAt ? (
            <span>
              <span className="text-zinc-600">Updated</span>{" "}
              <span className="tabular-nums text-zinc-300">
                {formatIso(data.metrics.lastUpdatedAt)}
              </span>
            </span>
          ) : null}
          {data?.metrics.truncated ? (
            <span className="text-amber-200/85">
              Subset shown ({data.metrics.nodesReturned}n /{" "}
              {data.metrics.edgesReturned}e) — totals are org-wide.
            </span>
          ) : null}
        </div>
      ) : null}

      {isLoading && !data ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center text-xs text-zinc-500">
          Loading graph…
        </div>
      ) : null}

      {error ? (
        <div
          className="absolute left-4 right-4 top-24 z-20 mx-auto max-w-md rounded-none border border-red-500/35 bg-zinc-950/92 px-3 py-2 text-xs text-red-200/95 shadow-xl shadow-black/40 backdrop-blur-md sm:top-28"
          role="alert"
        >
          {error instanceof Error ? error.message : "Failed to load graph."}
        </div>
      ) : null}

      {data && !error && graphPoints.length === 0 && !isLoading ? (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="max-w-md text-xs text-zinc-400">
            No graph data in FalkorDB for this organisation yet (this page does
            not read Postgres directly). Ingest repositories, then ensure claims
            are projected to the graph so nodes and edges appear here.
          </p>
        </div>
      ) : null}

      {search.trim() && searchMatchCount === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-[5] bg-zinc-950/75" />
      ) : null}

      {displayedNode && displayedFacts ? (
        <NodeDetailDrawer
          node={displayedNode}
          facts={displayedFacts}
          kindColor={
            kindColors.get(displayedNode.kind || "Unknown") ?? "#71717a"
          }
          kindColors={kindColors}
          open={drawerOpen}
          onClose={() => {
            setSelectedId(null)
            cgRef.current?.unselectAll()
          }}
          onFocus={() => {
            cgRef.current?.focusNode(displayedNode.id)
          }}
        />
      ) : null}
    </div>
  )
}

type NodeFactsForDrawer = {
  inDegree: number
  outDegree: number
  predicateCounts: Map<string, number>
  claimIds: Set<string>
  firstObserved: number | null
  lastObserved: number | null
  neighbourKindCounts: Map<string, number>
}

function NodeDetailDrawer({
  node,
  facts,
  kindColor,
  kindColors,
  open,
  onClose,
  onFocus,
}: {
  node: KnowledgeGraphPayload["nodes"][number]
  facts: NodeFactsForDrawer
  kindColor: string
  kindColors: Map<string, string>
  open: boolean
  onClose: () => void
  onFocus: () => void
}) {
  const kind = node.kind || "Unknown"
  const predicates = Array.from(facts.predicateCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  const neighbourKinds = Array.from(facts.neighbourKindCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  )
  const totalDegree = facts.inDegree + facts.outDegree
  const firstSeen = facts.firstObserved
    ? formatIso(new Date(facts.firstObserved).toISOString())
    : "—"
  const lastSeen = facts.lastObserved
    ? formatIso(new Date(facts.lastObserved).toISOString())
    : "—"

  const copyId = () => {
    void navigator.clipboard.writeText(node.id).catch(() => {})
  }

  return (
    <aside
      className={`absolute right-0 top-0 z-20 flex h-[100dvh] w-[340px] flex-col border-l border-zinc-800/95 bg-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-md transition-transform duration-200 ease-out motion-reduce:transition-none ${
        open
          ? "pointer-events-auto translate-x-0"
          : "pointer-events-none translate-x-full"
      }`}
      aria-label={`Details for ${node.name ?? node.id}`}
      aria-hidden={!open}
    >
      {/* Header: kind colour strip + close */}
      <div className="flex items-start gap-3 border-b border-zinc-800/95 p-4">
        <span
          className="mt-0.5 inline-block h-3 w-3 shrink-0"
          style={{ backgroundColor: kindColor }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
            {kind}
          </p>
          <h2 className="mt-0.5 truncate font-mono text-sm text-zinc-100">
            {node.name?.trim() || node.id}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-zinc-500 transition-colors hover:text-zinc-100"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
            aria-hidden
          >
            <title>Close</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* ID + copy */}
        <DetailRow label="Id">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-zinc-300">
              {node.id}
            </span>
            <button
              type="button"
              onClick={copyId}
              aria-label="Copy id"
              className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
            >
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <title>Copy id</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2M5 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"
                />
              </svg>
            </button>
          </div>
        </DetailRow>

        {node.summary?.trim() ? (
          <DetailRow label="Summary">
            <p className="whitespace-pre-wrap text-[12px] leading-snug text-zinc-300">
              {node.summary}
            </p>
          </DetailRow>
        ) : null}

        {/* Degree grid */}
        <DetailRow label="Connections">
          <div className="grid grid-cols-3 gap-0 border border-zinc-800/95">
            <StatCell label="In" value={facts.inDegree} />
            <StatCell label="Out" value={facts.outDegree} />
            <StatCell label="Total" value={totalDegree} accent />
          </div>
        </DetailRow>

        {/* Activity window */}
        {facts.firstObserved || facts.lastObserved ? (
          <DetailRow label="Activity">
            <div className="grid grid-cols-2 gap-0 border border-zinc-800/95">
              <StatCell label="First seen" value={firstSeen} text />
              <StatCell label="Last seen" value={lastSeen} text accent />
            </div>
          </DetailRow>
        ) : null}

        {/* Claims */}
        {facts.claimIds.size > 0 ? (
          <DetailRow label="Claims">
            <p className="font-mono text-xs tabular-nums text-zinc-300">
              {facts.claimIds.size.toLocaleString()} distinct claim
              {facts.claimIds.size === 1 ? "" : "s"}
            </p>
          </DetailRow>
        ) : null}

        {/* Predicates */}
        {predicates.length > 0 ? (
          <DetailRow label="Predicates">
            <div className="flex flex-wrap gap-1.5">
              {predicates.map(([pred, count]) => (
                <span
                  key={pred}
                  className="inline-flex items-center gap-1.5 border border-zinc-800/95 bg-zinc-900/70 px-1.5 py-0.5 text-[11px] text-zinc-300"
                >
                  <span>{pred}</span>
                  <span className="font-mono tabular-nums text-zinc-500">
                    {count}
                  </span>
                </span>
              ))}
            </div>
          </DetailRow>
        ) : null}

        {/* Neighbour kinds */}
        {neighbourKinds.length > 0 ? (
          <DetailRow label="Neighbour kinds">
            <ul className="flex flex-col gap-0.5">
              {neighbourKinds.map(([k, c]) => {
                const color = kindColors.get(k) ?? "#71717a"
                return (
                  <li
                    key={k}
                    className="flex items-center gap-2 text-[11px] text-zinc-300"
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{k}</span>
                    <span className="font-mono tabular-nums text-zinc-500">
                      {c}
                    </span>
                  </li>
                )
              })}
            </ul>
          </DetailRow>
        ) : null}
      </div>

      {/* Sticky action bar */}
      <div className="flex gap-0 border-t border-zinc-800/95 bg-zinc-950/90">
        <button
          type="button"
          onClick={onFocus}
          className="flex-1 px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-teal-400 transition-colors hover:bg-teal-500/10"
        >
          Focus
        </button>
        <div className="w-px bg-zinc-800/95" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          Close
        </button>
      </div>
    </aside>
  )
}

function DetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </p>
      {children}
    </div>
  )
}

function StatCell({
  label,
  value,
  text = false,
  accent = false,
}: {
  label: string
  value: number | string
  text?: boolean
  accent?: boolean
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 px-2.5 py-1.5 ${accent ? "bg-teal-500/5" : ""}`}
    >
      <span className="text-[9px] uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </span>
      <span
        className={`tabular-nums text-zinc-100 ${text ? "text-[11px]" : "font-mono text-sm font-semibold"}`}
      >
        {value}
      </span>
    </div>
  )
}

type ActivitySparklineProps = {
  buckets: number[]
  rangeStart: number
  rangeEnd: number
  total: number
}

/** Compact edge-observation histogram. Bars are drawn as absolutely-positioned
 * divs so the container can use the same dark sharp-cornered chrome as the other
 * floating panels — an SVG would work too but this composes better with the rest
 * of the UI kit's zinc tokens. */
function ActivitySparkline({
  buckets,
  rangeStart,
  rangeEnd,
  total,
}: ActivitySparklineProps) {
  const max = buckets.reduce((m, v) => (v > m ? v : m), 0)
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  })
  return (
    <div
      className="flex w-[200px] flex-col gap-1.5 rounded-none border border-zinc-800/95 bg-zinc-950/90 p-3 shadow-xl shadow-black/40 backdrop-blur-md"
      role="img"
      aria-label={`Edge activity: ${total} observations across ${buckets.length} buckets`}
    >
      <div className="flex items-baseline justify-between">
        <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          Activity
        </p>
        <p className="font-mono text-[10px] tabular-nums text-zinc-400">
          {total.toLocaleString()}
        </p>
      </div>
      <div className="flex h-8 items-end gap-[2px]">
        {buckets.map((count, i) => {
          const h = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order positional buckets
              key={i}
              className="flex-1 bg-teal-400/70"
              style={{ height: `${h}%` }}
              title={`${count} edge${count === 1 ? "" : "s"}`}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-[9px] tabular-nums text-zinc-600">
        <span>{formatter.format(new Date(rangeStart))}</span>
        <span>{formatter.format(new Date(rangeEnd))}</span>
      </div>
    </div>
  )
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-none border border-zinc-800/95 bg-zinc-950/90 px-3 py-1.5 shadow-xl shadow-black/40 backdrop-blur-md">
      <p className="text-[9px] uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </p>
      <p className="font-mono text-sm font-semibold tabular-nums text-zinc-100">
        {value.toLocaleString()}
      </p>
    </div>
  )
}

function MapControlButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <Button
      onPress={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-none border border-zinc-800/95 bg-zinc-950/90 text-zinc-300 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
    >
      {children}
    </Button>
  )
}

function formatIso(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d)
}
