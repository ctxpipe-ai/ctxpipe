import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { InlineAlert } from "@/components/ui/InlineAlert"
import type { ActivityBuckets } from "./ActivitySparkline"
import {
  type GraphLinkRow,
  KnowledgeGraphCosmographCanvas,
  type KnowledgeGraphCosmographCanvasHandle,
  type KnowledgeGraphSelectionEvent,
} from "./KnowledgeGraphCosmographCanvas"
import { type EmptyReason, KnowledgeGraphEmpty } from "./KnowledgeGraphEmpty"
import { KnowledgeGraphIntroCallout } from "./KnowledgeGraphIntroCallout"
import {
  dismissKnowledgeGraphIntro,
  shouldShowKnowledgeGraphIntro,
} from "./knowledgeGraphIntroStorage"
import { NodeDetailDrawer } from "./NodeDetailDrawer"
import {
  type SelectionInspectorModel,
  SelectionInspectorPanel,
} from "./SelectionInspectorPanel"
import { colorForKind, KIND_FALLBACK_COLOR } from "./theme"
import type {
  KnowledgeGraphPayload,
  NodeClaim,
  NodeFacts,
  NodeFactsSummary,
} from "./types"

/* Robust fitting keeps most focus nodes while trimming positional outliers. */
const KG_FIT_STRATEGY = "robust" as const

const DEEP_LINK_PARAM = "node"

type TimedEdgeIndex = {
  index: number
  stamp: number
}

function firstTimedEdgeAtOrAfter(
  edges: TimedEdgeIndex[],
  target: number,
): number {
  let low = 0
  let high = edges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((edges[mid]?.stamp ?? Number.POSITIVE_INFINITY) < target) low = mid + 1
    else high = mid
  }
  return low
}

function firstTimedEdgeAfter(edges: TimedEdgeIndex[], target: number): number {
  let low = 0
  let high = edges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((edges[mid]?.stamp ?? Number.POSITIVE_INFINITY) <= target) low = mid + 1
    else high = mid
  }
  return low
}

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

export function KnowledgeGraphExplorer({
  orgSlug,
  graph,
  pending = false,
  error = null,
  onOpenSource,
}: {
  orgSlug: string
  graph: KnowledgeGraphPayload | undefined
  pending?: boolean
  error?: Error | null
  onOpenSource?: (path: string) => void
}) {
  const data = graph
  const isLoading = pending
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readDeepLinkNodeId(),
  )
  const [kgIntroOpen, setKgIntroOpen] = useState(() =>
    shouldShowKnowledgeGraphIntro(orgSlug),
  )
  const [graphSelection, setGraphSelection] =
    useState<KnowledgeGraphSelectionEvent | null>(null)
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
    const facts = new Map<string, NodeFactsSummary>()
    const ensure = (id: string): NodeFactsSummary => {
      let f = facts.get(id)
      if (!f) {
        f = {
          inDegree: 0,
          outDegree: 0,
          predicateCounts: new Map(),
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
    const out: GraphLinkRow[] = []
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

  const edgeTimeIndex = useMemo<TimedEdgeIndex[]>(() => {
    const timed: TimedEdgeIndex[] = []
    graphLinks.forEach((link, index) => {
      const stamp = link.lastObservedAtMs
      if (typeof stamp !== "number" || !Number.isFinite(stamp)) return
      timed.push({ index, stamp })
    })
    timed.sort((a, b) => a.stamp - b.stamp)
    return timed
  }, [graphLinks])

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

  /* Product-specific selection bridge: drawer and deep-link focus can still
   * steer the canvas, while stock Cosmograph controls own search/filter
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
  }, [data, selectedId, nodeById])

  const onPointClick = useCallback((id: string | null) => {
    if (id) {
      setGraphSelection(null)
      cgRef.current?.clearSelectionFilters()
    }
    setSelectedId(id)
  }, [])

  const clearGraphSelection = useCallback(
    (options?: { resetCanvas?: boolean }) => {
      const shouldResetCanvas = options?.resetCanvas ?? true
      setSelectedId(null)
      setGraphSelection(null)
      if (shouldResetCanvas) {
        cgRef.current?.clearSelectionFilters()
      }
    },
    [],
  )

  const onBackgroundClick = useCallback(() => {
    // Cosmograph already handles its own "empty click" reset flow; only clear
    // product chrome here to avoid re-entering graph state updates mid-event.
    clearGraphSelection({ resetCanvas: false })
  }, [clearGraphSelection])

  const onGraphSelectionChange = useCallback(
    (selection: KnowledgeGraphSelectionEvent | null) => {
      setGraphSelection(selection)
      if (selection) {
        setSelectedId(null)
      }
    },
    [],
  )

  useEffect(() => {
    if (!selectedId && !graphSelection) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearGraphSelection()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [clearGraphSelection, graphSelection, selectedId])

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
  const displayedFactsSummary = displayedId
    ? (nodeFacts.get(displayedId) ?? null)
    : null
  const displayedFacts = useMemo<NodeFacts | null>(() => {
    if (!displayedId || !displayedNode) return null

    const claims: NodeClaim[] = []
    for (const link of graphLinks) {
      const observedAt = link.lastObservedAtMs
      if (link.source === displayedId) {
        claims.push({
          predicate: link.predicate,
          neighbourId: link.target,
          direction: "out",
          confidence: link.confidence,
          observedAt,
        })
      } else if (link.target === displayedId) {
        claims.push({
          predicate: link.predicate,
          neighbourId: link.source,
          direction: "in",
          confidence: link.confidence,
          observedAt,
        })
      }
    }

    return {
      ...(displayedFactsSummary ?? {
        inDegree: 0,
        outDegree: 0,
        predicateCounts: new Map<string, number>(),
        firstObserved: null,
        lastObserved: null,
        neighbourKindCounts: new Map<string, number>(),
      }),
      claims,
    }
  }, [displayedFactsSummary, displayedId, displayedNode, graphLinks])
  const drawerOpen = Boolean(selectedId && displayedNode)

  const showGraph = Boolean(data && !error && graphPoints.length > 0)

  const emptyReason: EmptyReason | null =
    !isLoading && !error && graphPoints.length === 0 ? "no-projection" : null

  const activityBuckets = useMemo<ActivityBuckets | null>(() => {
    if (edgeTimeIndex.length === 0) return null
    const min = edgeTimeIndex[0]?.stamp
    const max = edgeTimeIndex.at(-1)?.stamp
    if (min == null || max == null) return null
    const WEEK = 7 * 24 * 60 * 60 * 1000
    const span = Math.max(max - min, WEEK)
    const bucketCount = Math.min(24, Math.max(6, Math.ceil(span / WEEK)))
    const bucketSize = span / bucketCount
    const counts = new Array<number>(bucketCount).fill(0)
    for (const { stamp: t } of edgeTimeIndex) {
      const idx = Math.min(bucketCount - 1, Math.floor((t - min) / bucketSize))
      counts[idx] = (counts[idx] ?? 0) + 1
    }
    return {
      counts,
      rangeStart: min,
      rangeEnd: max,
      total: edgeTimeIndex.length,
    }
  }, [edgeTimeIndex])

  const selectionInspector = useMemo<SelectionInspectorModel | null>(() => {
    if (!graphSelection) return null

    const buildCounts = <T extends string>(values: T[]) =>
      Array.from(
        values.reduce((counts, value) => {
          counts.set(value, (counts.get(value) ?? 0) + 1)
          return counts
        }, new Map<T, number>()),
      ).sort((a, b) => b[1] - a[1])
    const sortCounts = <T extends string>(counts: Map<T, number>) =>
      Array.from(counts).sort((a, b) => b[1] - a[1])

    if (graphSelection.source === "lasso") {
      const nodeIds = [...new Set(graphSelection.nodeIds)].filter((id) =>
        nodeById.has(id),
      )
      const nodeIdSet = new Set(nodeIds)
      const nodes = nodeIds
        .map((id) => nodeById.get(id))
        .filter((node): node is KnowledgeGraphPayload["nodes"][number] =>
          Boolean(node),
        )
      let edgeCount = 0
      const predicateCounts = new Map<string, number>()
      for (const link of graphLinks) {
        if (!nodeIdSet.has(link.source) || !nodeIdSet.has(link.target)) continue
        edgeCount++
        const predicate = link.predicate || "Unknown"
        predicateCounts.set(
          predicate,
          (predicateCounts.get(predicate) ?? 0) + 1,
        )
      }
      return {
        source: "lasso",
        title: `${nodeIds.length.toLocaleString()} selected nodes`,
        description:
          "Spatial selection from the lasso. Edges shown here are links fully inside the selected node set.",
        nodeIds,
        nodes,
        edgeCount,
        kindCounts: buildCounts(nodes.map((node) => node.kind || "Unknown")),
        predicateCounts: sortCounts(predicateCounts),
      }
    }

    const { from, to } = graphSelection.range
    const start = firstTimedEdgeAtOrAfter(edgeTimeIndex, from)
    const end = firstTimedEdgeAfter(edgeTimeIndex, to)
    const nodeIdSet = new Set<string>()
    const predicateCounts = new Map<string, number>()
    let edgeCount = 0
    for (let i = start; i < end; i++) {
      const edgeIndex = edgeTimeIndex[i]?.index
      if (edgeIndex == null) continue
      const link = graphLinks[edgeIndex]
      if (!link) continue
      edgeCount++
      nodeIdSet.add(link.source)
      nodeIdSet.add(link.target)
      const predicate = link.predicate || "Unknown"
      predicateCounts.set(predicate, (predicateCounts.get(predicate) ?? 0) + 1)
    }
    const nodeIds = Array.from(nodeIdSet).filter((id) => nodeById.has(id))
    const nodes = nodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is KnowledgeGraphPayload["nodes"][number] =>
        Boolean(node),
      )

    return {
      source: "timeline",
      title: `${edgeCount.toLocaleString()} edges in range`,
      description:
        "Time filter from the historigram. The graph itself is filtered through Cosmograph crossfilter; this panel summarises the affected objects.",
      nodeIds,
      nodes,
      edgeCount,
      kindCounts: buildCounts(nodes.map((node) => node.kind || "Unknown")),
      predicateCounts: sortCounts(predicateCounts),
      range: { from, to },
    }
  }, [edgeTimeIndex, graphLinks, graphSelection, nodeById])

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
    <div className="relative z-10 h-full min-h-0 w-full min-w-0 shrink-0 @container">
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
                    Nodes{" "}
                    <span className="tabular-nums text-foreground">
                      {data.metrics.totalNodes.toLocaleString()}
                    </span>
                  </span>
                  <span>
                    Edges{" "}
                    <span className="tabular-nums text-foreground">
                      {data.metrics.totalEdges.toLocaleString()}
                    </span>
                  </span>
                  {hasLastUpdated ? (
                    <span>
                      Updated{" "}
                      <span className="tabular-nums text-foreground">
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
                      {data.metrics.edgesReturned}e).
                    </span>
                  ) : null}
                </div>
              ) : null
            }
            onTips={() => setKgIntroOpen((open) => !open)}
            tipsActive={kgIntroOpen}
            tipsPanel={
              <KnowledgeGraphIntroCallout
                open={kgIntroOpen}
                onDismiss={() => {
                  dismissKnowledgeGraphIntro(orgSlug)
                  setKgIntroOpen(false)
                }}
              />
            }
            onPointClick={onPointClick}
            onBackgroundClick={onBackgroundClick}
            onSelectionChange={onGraphSelectionChange}
          />
        </div>
      ) : null}

      {isLoading && !data ? (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background">
          <p className="text-sm font-medium text-foreground">Loading graph</p>
          <p className="text-sm text-muted-foreground">
            Large graphs may take a few seconds to arrive and lay out.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="absolute left-4 right-4 top-24 z-20 mx-auto max-w-md">
          <InlineAlert variant="error" title="Could not load graph">
            {error instanceof Error ? error.message : "Failed to load graph."}
          </InlineAlert>
        </div>
      ) : null}

      {emptyReason ? <KnowledgeGraphEmpty reason={emptyReason} /> : null}

      {selectionInspector && !displayedNode ? (
        <SelectionInspectorPanel
          key={`${selectionInspector.source}:${selectionInspector.title}`}
          selection={selectionInspector}
          kindColors={kindColors}
          onClose={() => {
            clearGraphSelection()
          }}
          onFitSelection={() => {
            if (selectionInspector.nodeIds.length === 0) return
            cgRef.current?.fitToIds(selectionInspector.nodeIds, {
              strategy: KG_FIT_STRATEGY,
            })
          }}
          onNodeSelect={(id) => {
            clearGraphSelection()
            setSelectedId(id)
          }}
        />
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
            clearGraphSelection()
          }}
          onFocus={() => {
            cgRef.current?.focusNode(displayedNode.id)
          }}
          onNeighbourSelect={(id) => setSelectedId(id)}
          onOpenSource={onOpenSource}
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
