import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { client } from "@/lib/api"
import type { ActivityBuckets } from "./ActivitySparkline"
import {
  KnowledgeGraphAskButton,
  KnowledgeGraphAskPanel,
} from "./KnowledgeGraphAskPanel"
import {
  type GraphLinkRow,
  KnowledgeGraphCosmographCanvas,
  type KnowledgeGraphCosmographCanvasHandle,
  type KnowledgeGraphSelectionEvent,
} from "./KnowledgeGraphCosmographCanvas"
import { type EmptyReason, KnowledgeGraphEmpty } from "./KnowledgeGraphEmpty"
import { KnowledgeGraphEvidenceReviewPanel } from "./KnowledgeGraphEvidenceReviewPanel"
import {
  KnowledgeGraphHelpButton,
  KnowledgeGraphIntroCallout,
} from "./KnowledgeGraphIntroCallout"
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

/* KG chat can highlight a richer context set than we should naively frame.
 * Robust fitting keeps most focus nodes while trimming positional outliers. */
const KG_FIT_STRATEGY = "robust" as const

const DEEP_LINK_PARAM = "node"
const REVIEW_PARAM = "review"
const SELECTION_FOCUS_NODE_LIMIT = 500

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

function readReviewOpen(): boolean {
  if (typeof window === "undefined") return false
  return (
    new URL(window.location.href).searchParams.get(REVIEW_PARAM) === "evidence"
  )
}

/** Mirror the current selected id to the URL without pushing a history entry. */
function syncDeepLink(nodeId: string | null, reviewOpen: boolean): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (nodeId) url.searchParams.set(DEEP_LINK_PARAM, nodeId)
  else url.searchParams.delete(DEEP_LINK_PARAM)
  if (reviewOpen) url.searchParams.set(REVIEW_PARAM, "evidence")
  else url.searchParams.delete(REVIEW_PARAM)
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
  const [reviewOpen, setReviewOpen] = useState(() => readReviewOpen())
  const [graphSelection, setGraphSelection] =
    useState<KnowledgeGraphSelectionEvent | null>(null)
  const cgRef = useRef<KnowledgeGraphCosmographCanvasHandle>(null)

  /** Keep intro visibility in sync with the active org's persisted dismissal state. */
  useEffect(() => {
    setKgIntroOpen(shouldShowKnowledgeGraphIntro(orgSlug))
  }, [orgSlug])

  /** Keep URL in sync with the selected node so the drawer state is shareable. */
  useEffect(() => {
    syncDeepLink(selectedId, reviewOpen)
  }, [reviewOpen, selectedId])

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
      setReviewOpen(false)
      setGraphSelection(null)
      cgRef.current?.clearSelectionFilters()
    }
    setSelectedId(id)
  }, [])

  const clearGraphSelection = useCallback(
    (options?: { resetCanvas?: boolean }) => {
      const shouldResetCanvas = options?.resetCanvas ?? true
      setSelectedId(null)
      setKgFocusIds([])
      setReviewOpen(false)
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
        setKgChatOpen(false)
        setKgChatSeed(null)
        setKgFocusIds([])
        setReviewOpen(false)
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

  const emptyReason: EmptyReason | null = useMemo(() => {
    if (!data || error || graphPoints.length > 0 || isLoading) return null
    if (!repos || repos.length === 0) return "no-repos"
    if (repos.some((r) => r.indexReady === false)) return "indexing"
    return "no-claims"
  }, [data, error, graphPoints.length, isLoading, repos])

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

  const focusKnowledgeGraphNodes = useCallback(
    ({ nodeIds, fitView }: { nodeIds: string[]; fitView: boolean }) => {
      const visibleIds = [...new Set(nodeIds)].filter((id) => nodeById.has(id))
      setKgFocusIds(visibleIds)
      setSelectedId(null)
      setGraphSelection(null)
      if (visibleIds.length === 0) {
        cgRef.current?.clearSelectionFilters()
        return
      }
      cgRef.current?.selectPointsWithAdjacentEdges(visibleIds)
      if (fitView) {
        cgRef.current?.fitToIds(visibleIds, { strategy: KG_FIT_STRATEGY })
      }
    },
    [nodeById],
  )

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

  const buildSelectionAskSeed = useCallback(
    (selection: SelectionInspectorModel): string => {
      const lines: string[] = []
      lines.push(`I want to understand this ${selection.title}.`)
      lines.push("")
      lines.push(
        `Selection source: ${
          selection.source === "lasso"
            ? "lasso spatial selection"
            : "historigram time filter"
        }.`,
      )
      if (selection.range) {
        lines.push(
          `Time range: ${formatIsoDateTime(
            new Date(selection.range.from).toISOString(),
          )} to ${formatIsoDateTime(new Date(selection.range.to).toISOString())}.`,
        )
      }
      lines.push(
        `Objects: ${selection.nodeIds.length.toLocaleString()} nodes, ${selection.edgeCount.toLocaleString()} edges.`,
      )
      if (selection.kindCounts.length > 0) {
        lines.push(
          `Top node kinds: ${selection.kindCounts
            .slice(0, 6)
            .map(([kind, count]) => `${kind} (${count})`)
            .join(", ")}.`,
        )
      }
      if (selection.predicateCounts.length > 0) {
        lines.push(
          `Top predicates: ${selection.predicateCounts
            .slice(0, 6)
            .map(([predicate, count]) => `${predicate} (${count})`)
            .join(", ")}.`,
        )
      }
      const examples = selection.nodes
        .slice(0, 12)
        .map((node) => `${node.name?.trim() || node.id} (${node.kind})`)
      if (examples.length > 0) {
        lines.push(`Representative nodes: ${examples.join(", ")}.`)
      }
      lines.push("")
      lines.push(
        "Please summarise what this selection represents, which nodes or relationships matter most, and what I should inspect next.",
      )
      return lines.join("\n")
    },
    [],
  )

  const selectionFocusIds = useCallback(
    (selection: SelectionInspectorModel) => {
      return selection.nodeIds.slice(0, SELECTION_FOCUS_NODE_LIMIT)
    },
    [],
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
  const showEmptyGraphChrome =
    !showGraph && !isLoading && Boolean(data || error)

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
            onSelectionChange={onGraphSelectionChange}
            centerControls={
              <KnowledgeGraphAskButton
                active={kgChatOpen}
                className="h-full border-zinc-800/95 bg-zinc-950/88 px-4 shadow-xl shadow-black/30 backdrop-blur hover:border-zinc-700 hover:bg-zinc-900/90"
                onClick={() => {
                  clearGraphSelection()
                  setReviewOpen(false)
                  setKgChatOpen((open) => !open)
                }}
              />
            }
          />
        </div>
      ) : null}

      {showEmptyGraphChrome ? (
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
            {!kgIntroOpen ? (
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
            cgRef.current?.clearSelectionFilters()
          }}
        />
      ) : null}

      {!kgChatOpen || reviewOpen ? (
        <KnowledgeGraphEvidenceReviewPanel
          orgSlug={orgSlug}
          open={reviewOpen}
          onOpenChange={(open) => {
            if (open) {
              setKgChatOpen(false)
              setKgChatSeed(null)
              setKgFocusIds([])
              setSelectedId(null)
              setGraphSelection(null)
              cgRef.current?.clearSelectionFilters()
            }
            setReviewOpen(open)
          }}
          onNodeSelect={(id) => {
            setKgChatOpen(false)
            setKgChatSeed(null)
            setKgFocusIds([])
            setGraphSelection(null)
            setSelectedId(id)
            cgRef.current?.selectNeighbourhood(id)
            cgRef.current?.focusNeighbourhood(id)
          }}
        />
      ) : null}

      {selectionInspector && !displayedNode && !kgChatOpen ? (
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
          onAskSelection={() => {
            const focusIds = selectionFocusIds(selectionInspector)
            setKgChatSeed(buildSelectionAskSeed(selectionInspector))
            setKgChatOpen(true)
            setKgFocusIds(focusIds)
            setGraphSelection(null)
            setSelectedId(null)
            cgRef.current?.selectPointsWithAdjacentEdges(focusIds)
            cgRef.current?.fitToIds(focusIds, { strategy: KG_FIT_STRATEGY })
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
            clearGraphSelection()
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
