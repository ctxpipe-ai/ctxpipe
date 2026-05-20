import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { client } from "@/lib/api"
import type { ActivityBuckets } from "./ActivitySparkline"
import {
  KnowledgeGraphAskButton,
  KnowledgeGraphAskPanel,
} from "./KnowledgeGraphAskPanel"
import {
  KnowledgeGraphCosmographCanvas,
  type KnowledgeGraphCosmographCanvasHandle,
} from "./KnowledgeGraphCosmographCanvas"
import { type EmptyReason, KnowledgeGraphEmpty } from "./KnowledgeGraphEmpty"
import {
  KnowledgeGraphHelpButton,
  KnowledgeGraphIntroCallout,
} from "./KnowledgeGraphIntroCallout"
import {
  dismissKnowledgeGraphIntro,
  shouldShowKnowledgeGraphIntro,
} from "./knowledgeGraphIntroStorage"
import { NodeDetailDrawer } from "./NodeDetailDrawer"
import { colorForKind, KIND_FALLBACK_COLOR } from "./theme"
import type { KnowledgeGraphPayload, NodeFacts } from "./types"

/* KG chat can highlight a richer context set than we should naively frame.
 * Robust fitting keeps most focus nodes while trimming positional outliers. */
const KG_FIT_STRATEGY = "robust" as const

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
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readDeepLinkNodeId(),
  )
  const [kgIntroOpen, setKgIntroOpen] = useState(() =>
    shouldShowKnowledgeGraphIntro(orgSlug),
  )
  const [kgChatOpen, setKgChatOpen] = useState(false)
  const [kgChatSeed, setKgChatSeed] = useState<string | null>(null)
  const [kgFocusIds, setKgFocusIds] = useState<string[]>([])
  const cgRef = useRef<KnowledgeGraphCosmographCanvasHandle>(null)

  /** Keep intro visibility in sync with the active org's persisted dismissal state. */
  useEffect(() => {
    setKgIntroOpen(shouldShowKnowledgeGraphIntro(orgSlug))
  }, [orgSlug])

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

  /* Pass rich semantic columns through to Cosmograph so its stock search,
   * legends, bars, timeline, and histogram can use native accessors. */
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
      return {
        id,
        label: n.name?.trim()
          ? `${n.name} (${kind})`
          : `${id.slice(0, 8)}… (${kind})`,
        kind,
        summary: n.summary ?? "",
        degree: deg,
      }
    })
  }, [sanitizedNodes, nodeFacts])

  const graphLinks = useMemo(() => {
    if (!data) return []
    const out: Array<{
      source: string
      target: string
      predicate: string
      confidence: number | null
      lastObservedAt: string
      lastObservedAtMs: number | null
    }> = []
    for (const e of data.edges) {
      if (e.sourceId == null || e.targetId == null) continue
      const s = String(e.sourceId)
      const t = String(e.targetId)
      if (!nodeById.has(s) || !nodeById.has(t)) continue
      const observedMs = e.lastObservedAt ? Date.parse(e.lastObservedAt) : NaN
      out.push({
        source: s,
        target: t,
        predicate: e.predicate || "Unknown",
        confidence: e.confidence,
        lastObservedAt: e.lastObservedAt ?? "",
        lastObservedAtMs: Number.isFinite(observedMs) ? observedMs : null,
      })
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

  /* Product-specific selection bridge: explicit drawer/Ask/deep-link focus can
   * still steer the canvas, while stock Cosmograph controls own search/filter
   * selection. */
  useEffect(() => {
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

    const visibleKgFocusIds = kgFocusIds.filter((id) => nodeById.has(id))
    if (visibleKgFocusIds.length > 0) {
      cgRef.current?.selectPointsWithAdjacentEdges(visibleKgFocusIds)
    }
  }, [data, selectedId, nodeById, kgFocusIds])

  const onPointClick = useCallback((id: string | null) => {
    if (id) {
      setKgChatOpen(false)
      setKgChatSeed(null)
      setKgFocusIds([])
    }
    setSelectedId(id)
  }, [])

  const onBackgroundClick = useCallback(() => {
    setSelectedId(null)
    setKgFocusIds([])
    cgRef.current?.unselectAll()
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

  const focusKnowledgeGraphNodes = useCallback(
    ({ nodeIds, fitView }: { nodeIds: string[]; fitView: boolean }) => {
      const visibleIds = [...new Set(nodeIds)].filter((id) => nodeById.has(id))
      setKgFocusIds(visibleIds)
      setSelectedId(null)
      if (visibleIds.length === 0) {
        cgRef.current?.unselectAll()
        return
      }
      cgRef.current?.selectPointsWithAdjacentEdges(visibleIds)
      if (fitView) {
        cgRef.current?.fitToIds(visibleIds, { strategy: KG_FIT_STRATEGY })
      }
    },
    [nodeById],
  )

  /* Backend stopped sending `metrics.lastUpdatedAt` because the Cypher `max()`
   * aggregation didn't scale. Compute it client-side from the max of edge
   * observation timestamps collected for the stock controls. */
  const inferredLastUpdatedMs =
    data?.metrics.lastUpdatedAt != null
      ? Date.parse(data.metrics.lastUpdatedAt)
      : (activityBuckets?.rangeEnd ?? null)
  const hasLastUpdated =
    inferredLastUpdatedMs != null && Number.isFinite(inferredLastUpdatedMs)

  return (
    <div className="relative z-10 h-[100dvh] min-h-[100dvh] w-full shrink-0">
      {showGraph ? (
        <div className="absolute inset-0 z-0 h-full w-full min-h-0">
          <KnowledgeGraphCosmographCanvas
            ref={cgRef}
            points={graphPoints}
            links={graphLinks}
            footerMetadata={
              data?.metrics ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 leading-none">
                  <span>
                    <span>Nodes</span>{" "}
                    <span className="tabular-nums text-zinc-400">
                      {data.metrics.totalNodes.toLocaleString()}
                    </span>
                  </span>
                  <span>
                    <span>Edges</span>{" "}
                    <span className="tabular-nums text-zinc-400">
                      {data.metrics.totalEdges.toLocaleString()}
                    </span>
                  </span>
                  {hasLastUpdated ? (
                    <span>
                      <span>Updated</span>{" "}
                      <span className="tabular-nums text-zinc-400">
                        {formatIsoDateTime(
                          new Date(
                            inferredLastUpdatedMs as number,
                          ).toISOString(),
                        )}
                      </span>
                    </span>
                  ) : null}
                  {data.metrics.truncated ? (
                    <span className="text-amber-200/85">
                      Subset shown ({data.metrics.nodesReturned}n /{" "}
                      {data.metrics.edgesReturned}e); totals are org-wide.
                    </span>
                  ) : null}
                </div>
              ) : null
            }
            onPointClick={onPointClick}
            onBackgroundClick={onBackgroundClick}
            centerControls={
              <KnowledgeGraphAskButton
                active={kgChatOpen}
                className="h-full border-zinc-800/95 bg-zinc-950/88 px-4 shadow-xl shadow-black/30 backdrop-blur hover:border-zinc-700 hover:bg-zinc-900/90"
                onClick={() => {
                  setSelectedId(null)
                  setKgChatOpen((open) => !open)
                }}
              />
            }
          />
        </div>
      ) : null}

      {!showGraph ? (
        <div className="pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100vw-2rem)] flex-col items-start gap-3">
          <h1 className="font-mono text-[12px] uppercase tracking-[0.24em] text-teal-400 drop-shadow-[0_1px_8px_rgba(0,0,0,0.85)]">
            Knowledge graph
          </h1>
          <div className="pointer-events-auto flex flex-col gap-2">
            <KnowledgeGraphIntroCallout
              open={kgIntroOpen}
              onDismiss={() => {
                dismissKnowledgeGraphIntro(orgSlug)
                setKgIntroOpen(false)
              }}
            />
            {!showGraph && !kgIntroOpen ? (
              <KnowledgeGraphHelpButton onClick={() => setKgIntroOpen(true)} />
            ) : null}
          </div>
        </div>
      ) : null}

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

      {showGraph ? (
        <KnowledgeGraphAskPanel
          orgSlug={orgSlug}
          open={kgChatOpen}
          onOpenChange={setKgChatOpen}
          selectedNode={selectedId ? (nodeById.get(selectedId) ?? null) : null}
          nodes={sanitizedNodes}
          highlightedNodeCount={kgFocusIds.length}
          search=""
          seed={kgChatSeed}
          onSeedConsumed={() => setKgChatSeed(null)}
          onFocus={focusKnowledgeGraphNodes}
          onFitFocus={() => {
            if (kgFocusIds.length === 0) return
            cgRef.current?.fitToIds(kgFocusIds, { strategy: KG_FIT_STRATEGY })
          }}
          onClearFocus={() => {
            setKgFocusIds([])
            cgRef.current?.unselectAll()
          }}
        />
      ) : null}

      {displayedNode && displayedFacts && !kgChatOpen ? (
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
          onAskAgent={(seed) => {
            setKgChatSeed(seed)
            setKgChatOpen(true)
            setKgFocusIds([displayedNode.id])
            setSelectedId(null)
            cgRef.current?.selectPointsWithAdjacentEdges([displayedNode.id])
            cgRef.current?.fitToIds([displayedNode.id])
          }}
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
