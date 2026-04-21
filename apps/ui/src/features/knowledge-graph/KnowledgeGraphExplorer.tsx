import {
  IconMaximize,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { client } from "@/lib/api"
import { cn } from "@/lib/utils"
import { type ActivityBuckets, ActivitySparkline } from "./ActivitySparkline"
import { FloatingPanel, PanelLabel } from "./FloatingPanel"
import {
  KnowledgeGraphCosmographCanvas,
  type KnowledgeGraphCosmographCanvasHandle,
} from "./KnowledgeGraphCosmographCanvas"
import { type EmptyReason, KnowledgeGraphEmpty } from "./KnowledgeGraphEmpty"
import { MapControlButton } from "./MapControlButton"
import { MetricChip } from "./MetricChip"
import { NodeDetailDrawer } from "./NodeDetailDrawer"
import { colorForKind, KIND_FALLBACK_COLOR, LINK_BASE } from "./theme"
import type { KnowledgeGraphPayload, NodeFacts } from "./types"

const SEARCH_DEBOUNCE_MS = 220
/* When search matches <= this, we auto-fit the viewport to them. Above that the
 * fitted box is indistinguishable from the whole graph. */
const FIT_TO_MATCHES_THRESHOLD = 200

// Previously baked alpha into node colors as `#RRGGBBAA`/`rgba()` — removed
// because Cosmograph's data-prep pipeline was choking on either format at
// 200k-node scale, leaving the canvas blank with no visible error.

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

const DEEP_LINK_PARAM = "node"

/** Read the `?node=<id>` search param once on mount without coupling to a
 * router — plain History API keeps this self-contained. */
function readDeepLinkNodeId(): string | null {
  if (typeof window === "undefined") return null
  const url = new URL(window.location.href)
  return url.searchParams.get(DEEP_LINK_PARAM)
}

/** Mirror the current selected id to the URL without pushing a history entry. */
function syncDeepLink(nodeId: string | null): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (nodeId) url.searchParams.set(DEEP_LINK_PARAM, nodeId)
  else url.searchParams.delete(DEEP_LINK_PARAM)
  window.history.replaceState(window.history.state, "", url)
}

export function KnowledgeGraphExplorer({ orgSlug }: { orgSlug: string }) {
  const [search, setSearch] = useState("")
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readDeepLinkNodeId(),
  )
  const cgRef = useRef<KnowledgeGraphCosmographCanvasHandle>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Keep URL in sync with the selected node so the drawer state is shareable. */
  useEffect(() => {
    syncDeepLink(selectedId)
  }, [selectedId])

  /** Once data lands for a deep-linked node, recenter the viewport on it. */
  const deepLinkFocusedRef = useRef(false)

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

  /* Used only to pick an honest empty-state message — "no repos" vs "still
   * indexing" vs "indexed but no claims yet". */
  const { data: repos } = useQuery({
    queryKey: ["repositories", orgSlug],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.repositories.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to fetch repositories")
      const json = (await res.json()) as {
        items: Array<{ indexReady?: boolean }>
      }
      return json.items
    },
  })

  const sanitizedNodes = useMemo(() => {
    if (!data?.nodes) return []
    return data.nodes.filter((n) => n.id != null && String(n.id).length > 0)
  }, [data])

  const nodeById = useMemo(() => {
    const m = new Map<string, KnowledgeGraphPayload["nodes"][number]>()
    for (const n of sanitizedNodes) m.set(String(n.id), n)
    return m
  }, [sanitizedNodes])

  const kindColors = useMemo(() => {
    const map = new Map<string, string>()
    for (const n of sanitizedNodes) {
      const k = n.kind || "Unknown"
      if (!map.has(k)) map.set(k, colorForKind(k))
    }
    return map
  }, [sanitizedNodes])

  const allKinds = useMemo(
    () => Array.from(kindColors.keys()).sort(),
    [kindColors],
  )

  const nodeFacts = useMemo(() => {
    const facts = new Map<string, NodeFacts>()
    const ensure = (id: string): NodeFacts => {
      let f = facts.get(id)
      if (!f) {
        f = {
          inDegree: 0,
          outDegree: 0,
          predicateCounts: new Map(),
          firstObserved: null,
          lastObserved: null,
          neighbourKindCounts: new Map(),
          claims: [],
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
      if (!nodeById.has(s) || !nodeById.has(t)) continue
      const src = ensure(s)
      const tgt = ensure(t)
      src.outDegree++
      tgt.inDegree++
      const pred = e.predicate || "—"
      src.predicateCounts.set(pred, (src.predicateCounts.get(pred) ?? 0) + 1)
      tgt.predicateCounts.set(pred, (tgt.predicateCounts.get(pred) ?? 0) + 1)
      const ts = e.lastObservedAt ? Date.parse(e.lastObservedAt) : NaN
      const observedAt = Number.isFinite(ts) ? ts : null
      if (observedAt != null) {
        for (const f of [src, tgt]) {
          f.firstObserved =
            f.firstObserved == null
              ? observedAt
              : Math.min(f.firstObserved, observedAt)
          f.lastObserved =
            f.lastObserved == null
              ? observedAt
              : Math.max(f.lastObserved, observedAt)
        }
      }
      src.claims.push({
        predicate: pred,
        neighbourId: t,
        direction: "out",
        confidence: e.confidence,
        observedAt,
      })
      tgt.claims.push({
        predicate: pred,
        neighbourId: s,
        direction: "in",
        confidence: e.confidence,
        observedAt,
      })
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
  }, [data, nodeById])

  /* Pass the FULL node/link set to Cosmograph and drive both search and kind
   * filters through selection-based dimming — filtering the data array caused
   * the simulation to restart on every toggle.
   *
   * Alpha-by-degree: low-degree nodes get baked-in transparency via 8-digit
   * hex so they visually fade into the background at default zoom (high-degree
   * nodes dominate), without having to run a per-frame onZoom handler or fight
   * the existing selection state. */
  const graphPoints = useMemo(() => {
    const degrees: number[] = []
    for (const n of sanitizedNodes) {
      const f = nodeFacts.get(String(n.id))
      degrees.push((f?.inDegree ?? 0) + (f?.outDegree ?? 0))
    }
    return sanitizedNodes.map((n, i) => {
      const id = String(n.id)
      const kind = n.kind || "Unknown"
      const deg = degrees[i] ?? 0
      const hex = kindColors.get(kind) ?? KIND_FALLBACK_COLOR
      return {
        id,
        label: n.name?.trim()
          ? `${n.name} (${kind})`
          : `${id.slice(0, 8)}… (${kind})`,
        color: hex,
        size: 1 + Math.log2(deg + 1),
      }
    })
  }, [sanitizedNodes, kindColors, nodeFacts])

  const graphLinks = useMemo(() => {
    if (!data) return []
    const out: Array<{ source: string; target: string; color: string }> = []
    for (const e of data.edges) {
      if (e.sourceId == null || e.targetId == null) continue
      const s = String(e.sourceId)
      const t = String(e.targetId)
      if (!nodeById.has(s) || !nodeById.has(t)) continue
      out.push({ source: s, target: t, color: LINK_BASE })
    }
    return out
  }, [data, nodeById])

  /** Sorted ascending degrees per kind — lets the drawer compute the selected
   * node's degree percentile within its peer group ("top 3% of Service"). */
  const degreesByKind = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const n of sanitizedNodes) {
      const kind = n.kind || "Unknown"
      const f = nodeFacts.get(String(n.id))
      const deg = (f?.inDegree ?? 0) + (f?.outDegree ?? 0)
      const arr = map.get(kind)
      if (arr) arr.push(deg)
      else map.set(kind, [deg])
    }
    for (const arr of map.values()) arr.sort((a, b) => a - b)
    return map
  }, [sanitizedNodes, nodeFacts])

  /* Unified search id set — feeds both Cosmograph selection and the match count
   * label, so we don't scan `sanitizedNodes` twice per keystroke. */
  const searchPool = useMemo(() => {
    if (hiddenKinds.size === 0) return sanitizedNodes
    return sanitizedNodes.filter((n) => !hiddenKinds.has(n.kind || "Unknown"))
  }, [sanitizedNodes, hiddenKinds])

  const searchMatches = useMemo(
    () => buildSearchIdSet(searchPool, search),
    [searchPool, search],
  )

  /* Selection priority: clicked node (neighbourhood) > search > kind filter >
   * nothing. The first wins regardless of the others because an open drawer
   * trumps ambient filtering. */
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!data) return

    if (selectedId) {
      cgRef.current?.selectNeighbourhood(selectedId)
      if (!deepLinkFocusedRef.current && nodeById.has(selectedId)) {
        // One-shot: on first render after arriving with ?node= in the URL,
        // zoom to the node + its 1-hop neighbourhood so the landing frame has
        // context instead of a lone dot.
        deepLinkFocusedRef.current = true
        cgRef.current?.focusNeighbourhood(selectedId)
      }
      return
    }

    const hasSearch = search.trim().length > 0
    const hasKindFilter = hiddenKinds.size > 0
    if (!hasSearch && !hasKindFilter) {
      cgRef.current?.unselectAll()
      return
    }

    const apply = () => {
      const ids = hasSearch
        ? Array.from(searchMatches)
        : searchPool.map((n) => String(n.id))
      if (ids.length === 0) {
        cgRef.current?.selectPoints([])
        return
      }
      cgRef.current?.selectPoints(ids)
      if (hasSearch && ids.length <= FIT_TO_MATCHES_THRESHOLD) {
        cgRef.current?.fitToIds(ids)
      }
    }

    if (hasSearch) {
      searchDebounceRef.current = setTimeout(apply, SEARCH_DEBOUNCE_MS)
    } else {
      apply()
    }
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [
    search,
    hiddenKinds,
    searchPool,
    searchMatches,
    data,
    selectedId,
    nodeById,
  ])

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
   * drawer doesn't blank before translating off-screen. */
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
  const searchMatchCount = search.trim() ? searchMatches.size : null

  const emptyReason: EmptyReason | null = useMemo(() => {
    if (!data || error || graphPoints.length > 0 || isLoading) return null
    if (!repos || repos.length === 0) return "no-repos"
    if (repos.some((r) => r.indexReady === false)) return "indexing"
    return "no-claims"
  }, [data, error, graphPoints.length, isLoading, repos])

  const activityBuckets = useMemo<ActivityBuckets | null>(() => {
    if (!data) return null
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    const stamps: number[] = []
    for (const e of data.edges) {
      if (!e.lastObservedAt) continue
      const t = Date.parse(e.lastObservedAt)
      if (!Number.isFinite(t)) continue
      if (t < min) min = t
      if (t > max) max = t
      stamps.push(t)
    }
    if (stamps.length === 0) return null
    const WEEK = 7 * 24 * 60 * 60 * 1000
    const span = Math.max(max - min, WEEK)
    const bucketCount = Math.min(24, Math.max(6, Math.ceil(span / WEEK)))
    const bucketSize = span / bucketCount
    const counts = new Array<number>(bucketCount).fill(0)
    for (const t of stamps) {
      const idx = Math.min(bucketCount - 1, Math.floor((t - min) / bucketSize))
      counts[idx] = (counts[idx] ?? 0) + 1
    }
    return { counts, rangeStart: min, rangeEnd: max, total: stamps.length }
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

      <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-3">
        <h1 className="font-mono text-[12px] uppercase tracking-[0.24em] text-teal-400 drop-shadow-[0_1px_8px_rgba(0,0,0,0.85)]">
          Knowledge graph
        </h1>
        {showGraph && data?.metrics ? (
          <div className="pointer-events-auto flex gap-2">
            <MetricChip label="Nodes" value={data.metrics.totalNodes} />
            <MetricChip label="Edges" value={data.metrics.totalEdges} />
          </div>
        ) : null}
      </div>

      {showGraph ? (
        <div className="pointer-events-auto absolute left-1/2 top-4 z-10 -translate-x-1/2">
          <FloatingPanel className="flex items-center gap-2 px-3 py-2 focus-within:border-teal-500/55">
            <IconSearch
              className="h-3.5 w-3.5 shrink-0 text-zinc-500"
              aria-hidden
            />
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
              className="w-72 bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            {search.trim() ? (
              <div className="flex shrink-0 items-center gap-2 border-l border-zinc-800/95 pl-2">
                <span className="text-[12px] tabular-nums text-zinc-400">
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
                  <IconX className="h-3 w-3" aria-hidden />
                </button>
              </div>
            ) : null}
          </FloatingPanel>
        </div>
      ) : null}

      <div
        className="pointer-events-auto absolute right-4 top-4 z-10 flex items-start gap-3 transition-opacity duration-200"
        style={{
          opacity: drawerOpen ? 0 : 1,
          pointerEvents: drawerOpen ? "none" : "auto",
        }}
      >
        {activityBuckets ? (
          <ActivitySparkline buckets={activityBuckets} />
        ) : null}
        {allKinds.length > 0 ? (
          <FloatingPanel className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto p-3">
            <PanelLabel className="mb-1.5">Node kinds</PanelLabel>
            {allKinds.map((kind) => {
              const isHidden = hiddenKinds.has(kind)
              const color = kindColors.get(kind) ?? KIND_FALLBACK_COLOR
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleKind(kind)}
                  className={cn(
                    "flex items-center gap-2 rounded-none px-1 py-0.5 text-left transition-opacity hover:bg-white/5",
                    isHidden && "opacity-35",
                  )}
                  aria-pressed={!isHidden}
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0"
                    style={{ backgroundColor: isHidden ? "#52525b" : color }}
                  />
                  <span
                    className={cn(
                      "text-[13px]",
                      isHidden ? "text-zinc-600 line-through" : "text-zinc-300",
                    )}
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
                className="mt-1.5 text-left text-[12px] text-teal-400 hover:text-teal-300"
              >
                Show all
              </button>
            ) : null}
          </FloatingPanel>
        ) : null}
      </div>

      {showGraph ? (
        <div className="pointer-events-auto absolute bottom-4 right-4 z-10 flex flex-col gap-1">
          <MapControlButton
            onClick={() => void refetch()}
            label="Refresh graph"
          >
            <IconRefresh
              className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
              aria-hidden
            />
          </MapControlButton>
          <MapControlButton
            onClick={() => cgRef.current?.fitView?.()}
            label="Fit view"
          >
            <IconMaximize className="h-3.5 w-3.5" aria-hidden />
          </MapControlButton>
        </div>
      ) : null}

      {(() => {
        /* Backend stopped sending `metrics.lastUpdatedAt` because the Cypher
         * `max()` aggregation didn't scale. Compute it client-side from the
         * max of edge observation timestamps — already collected for the
         * Activity sparkline. */
        const inferredLastUpdatedMs =
          data?.metrics.lastUpdatedAt != null
            ? Date.parse(data.metrics.lastUpdatedAt)
            : (activityBuckets?.rangeEnd ?? null)
        const hasLastUpdated =
          inferredLastUpdatedMs != null &&
          Number.isFinite(inferredLastUpdatedMs)
        if (!hasLastUpdated && !data?.metrics.truncated) return null
        return (
          <FloatingPanel className="pointer-events-auto absolute bottom-4 left-4 z-10 flex flex-col gap-0.5 px-3 py-2 text-[12px] leading-tight text-zinc-500">
            {hasLastUpdated ? (
              <span>
                <span className="text-zinc-600">Updated</span>{" "}
                <span className="tabular-nums text-zinc-300">
                  {formatIsoDateTime(
                    new Date(inferredLastUpdatedMs as number).toISOString(),
                  )}
                </span>
              </span>
            ) : null}
            {data?.metrics.truncated ? (
              <span className="text-amber-200/85">
                Subset shown ({data.metrics.nodesReturned}n /{" "}
                {data.metrics.edgesReturned}e) — totals are org-wide.
              </span>
            ) : null}
          </FloatingPanel>
        )
      })()}

      {isLoading && !data ? (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3"
          style={{ backgroundColor: "#09090b" }}
        >
          <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.24em] text-teal-400">
            <span className="inline-block h-1.5 w-1.5 animate-pulse bg-teal-400" />
            <span>Loading knowledge graph</span>
          </div>
          <p className="text-[12px] text-zinc-600">
            Large graphs may take a few seconds to arrive and lay out.
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          className="absolute left-4 right-4 top-24 z-20 mx-auto max-w-md rounded-none border border-red-500/35 bg-zinc-950/92 px-3 py-2 text-[13px] text-red-200/95 shadow-xl shadow-black/40 backdrop-blur-md sm:top-28"
          role="alert"
        >
          {error instanceof Error ? error.message : "Failed to load graph."}
        </div>
      ) : null}

      {emptyReason ? (
        <KnowledgeGraphEmpty
          reason={emptyReason}
          orgSlug={orgSlug}
          isFetching={isFetching}
          onRefresh={() => void refetch()}
        />
      ) : null}

      {search.trim() && searchMatchCount === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-[5] bg-zinc-950/75" />
      ) : null}

      {displayedNode && displayedFacts ? (
        <NodeDetailDrawer
          node={displayedNode}
          facts={displayedFacts}
          kindColor={
            kindColors.get(displayedNode.kind || "Unknown") ??
            KIND_FALLBACK_COLOR
          }
          kindColors={kindColors}
          nodeById={nodeById}
          peerDegrees={degreesByKind.get(displayedNode.kind || "Unknown") ?? []}
          open={drawerOpen}
          onClose={() => {
            setSelectedId(null)
            cgRef.current?.unselectAll()
          }}
          onFocus={() => {
            cgRef.current?.focusNode(displayedNode.id)
          }}
          onNeighbourSelect={(id) => setSelectedId(id)}
        />
      ) : null}
    </div>
  )
}

function formatIsoDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d)
}
