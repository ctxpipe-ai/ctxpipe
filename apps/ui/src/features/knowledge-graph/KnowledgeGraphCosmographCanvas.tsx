import {
  Cosmograph,
  type CosmographConfig,
  type CosmographDataPrepConfig,
  CosmographProvider,
  type CosmographRef,
  CosmographTimeline,
  type CosmographTimelineRef,
  prepareCosmographData,
} from "@cosmograph/react"
import {
  type CSSProperties,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { ProgressLoader } from "@/components/ui/InlineLoader"
import { buildFocusFitTarget } from "./knowledgeGraphFocusFit"
import {
  KIND_FALLBACK_COLOR,
  KIND_PALETTE,
  LINK_BASE,
  PAGE_BG,
  UNKNOWN_COLOR,
} from "./theme"

export type KnowledgeGraphCosmographCanvasHandle = {
  fitView: () => void
  fitToIds: (ids: string[], options?: FitToIdsOptions) => void
  focusNode: (id: string) => void
  /** Zoom so the node and its 1-hop neighbours fit the viewport — contextual
   * framing for deep-link landings, unlike `focusNode` which over-zooms. */
  focusNeighbourhood: (id: string) => void
  selectPoints: (ids: string[]) => void
  /** Focus points plus their 1-hop neighbours; used to keep incident edges
   * visually bright while preserving the caller's smaller focus list. */
  selectPointsWithAdjacentEdges: (ids: string[]) => void
  /** Node + its 1-hop neighbours; others dim. */
  selectNeighbourhood: (id: string) => void
  unselectAll: () => void
  clearSelectionFilters: () => void
}

export type GraphPointRow = {
  id: string
  label: string
  kind: string
  summary: string
  degree: number
}

export type GraphLinkRow = {
  source: string
  target: string
  predicate: string
  confidence: number | null
  lastObservedAt: string
  lastObservedAtMs: number | null
}

export type KnowledgeGraphSelectionEvent =
  | {
      source: "lasso"
      nodeIds: string[]
    }
  | {
      source: "timeline"
      range: { from: number; to: number }
    }

type FitToIdsOptions = {
  padding?: number
  strategy?: "all" | "robust"
}

type KnowledgeGraphCosmographCanvasProps = {
  points: GraphPointRow[]
  links: GraphLinkRow[]
  centerControls?: ReactNode
  footerMetadata?: ReactNode
  /** `null` when the click missed a point. */
  onPointClick: (id: string | null) => void
  onBackgroundClick: () => void
  onSelectionChange: (selection: KnowledgeGraphSelectionEvent | null) => void
}

type TimelineSelection =
  | [Date, Date]
  | [number, number]
  | Array<Date | number>
  | undefined

const REVEAL_AFTER_FIT_MS = 80
const REVEAL_AFTER_REBUILD_MS = 250
const FOCUS_FIT_PADDING = 0.12
const INITIAL_EXTENTS_FIT_PADDING = 0.1
const GRAPH_SIMULATION_RESTART_ALPHA = 0.35
const GRAPH_SIMULATION_PRESET = {
  simulationGravity: 0.46,
  simulationRepulsion: 1.32,
  simulationLinkSpring: 0.08,
  simulationLinkDistance: 2,
  simulationFriction: 0.77,
  simulationCluster: 0.1,
} satisfies Partial<CosmographConfig>

/** Hide only the very first layout scramble, then reveal while Cosmograph's
 * simulation is still alive so the graph visibly relaxes like the stock demos. */
export const KnowledgeGraphCosmographCanvas = forwardRef<
  KnowledgeGraphCosmographCanvasHandle,
  KnowledgeGraphCosmographCanvasProps
>(function KnowledgeGraphCosmographCanvas(
  {
    points,
    links,
    centerControls,
    footerMetadata,
    onPointClick,
    onBackgroundClick,
    onSelectionChange,
  },
  ref,
) {
  const cosmographRef = useRef<CosmographRef>(undefined)
  const timelineRef = useRef<CosmographTimelineRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig | null>(null)
  const [isSettled, setIsSettled] = useState(false)
  const [isSimulationRunning, setIsSimulationRunning] = useState(false)
  const [isLassoActive, setIsLassoActive] = useState(false)
  const [prepStage, setPrepStage] = useState<"idle" | "preparing" | "error">(
    "idle",
  )
  const [prepError, setPrepError] = useState<string | null>(null)
  const hasInitialFitRef = useRef(false)
  const pointIdsRef = useRef<string[]>([])
  const pointIndexByIdRef = useRef<Map<string, number>>(new Map())
  const isLassoActiveRef = useRef(false)
  const onPointClickRef = useRef(onPointClick)
  const onBackgroundClickRef = useRef(onBackgroundClick)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onPointClickRef.current = onPointClick
  onBackgroundClickRef.current = onBackgroundClick
  onSelectionChangeRef.current = onSelectionChange
  const degreeLegend = useMemo(() => buildDegreeLegend(points), [points])

  const handleCanvasPointIndex = useCallback((index: number | undefined) => {
    if (index === undefined) {
      onBackgroundClickRef.current()
      return
    }
    onPointClickRef.current(pointIdsRef.current[index] ?? null)
  }, [])

  const getPointIndicesForIds = useCallback((ids: string[]) => {
    const indexById = pointIndexByIdRef.current
    const seen = new Set<number>()
    const indices: number[] = []
    for (const id of ids) {
      const index = indexById.get(id)
      if (index === undefined || seen.has(index)) continue
      seen.add(index)
      indices.push(index)
    }
    return indices
  }, [])

  const focusSearchIds = useCallback(
    (ids: string[]) => {
      const indices = getPointIndicesForIds(ids)
      if (indices.length === 0) return
      cosmographRef.current?.selectPoints?.(indices)
      cosmographRef.current?.fitViewByIndices?.(indices, 500, FOCUS_FIT_PADDING)
    },
    [getPointIndicesForIds],
  )

  const toggleSimulation = useCallback(() => {
    if (isSimulationRunning) {
      cosmographRef.current?.pause?.()
      setIsSimulationRunning(false)
      return
    }
    cosmographRef.current?.start?.(GRAPH_SIMULATION_RESTART_ALPHA)
    setIsSimulationRunning(true)
  }, [isSimulationRunning])

  const toggleLasso = useCallback(() => {
    if (isLassoActive) {
      cosmographRef.current?.deactivatePolygonalSelection?.()
      isLassoActiveRef.current = false
      setIsLassoActive(false)
      return
    }
    cosmographRef.current?.activatePolygonalSelection?.()
    isLassoActiveRef.current = true
    setIsLassoActive(true)
  }, [isLassoActive])

  const clearSelectionFilters = useCallback(() => {
    cosmographRef.current?.deactivatePolygonalSelection?.()
    isLassoActiveRef.current = false
    setIsLassoActive(false)
    cosmographRef.current?.unselectAllPoints?.()
    timelineRef.current?.setSelection?.()
    onSelectionChangeRef.current(null)
  }, [])

  const handleTimelineSelection = useCallback(
    (selection: TimelineSelection) => {
      if (!selection || selection.length < 2) {
        onSelectionChangeRef.current(null)
        return
      }
      const start = selection[0]
      const end = selection[1]
      if (start == null || end == null) {
        onSelectionChangeRef.current(null)
        return
      }
      const from = start instanceof Date ? start.getTime() : start
      const to = end instanceof Date ? end.getTime() : end
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        onSelectionChangeRef.current(null)
        return
      }
      onSelectionChangeRef.current({
        source: "timeline",
        range: {
          from: Math.min(from, to),
          to: Math.max(from, to),
        },
      })
    },
    [],
  )

  const handleTimelineAnimationPause = useCallback(
    (_isAnimationRunning: boolean, selection: TimelineSelection) => {
      if (!selection) {
        onSelectionChangeRef.current(null)
      }
    },
    [],
  )

  const emitLassoSelection = useCallback((selectedIndices: number[]) => {
    if (!isLassoActiveRef.current) return

    const nodeIds = selectedIndices
      .map((index) => pointIdsRef.current[index])
      .filter((id): id is string => typeof id === "string")

    cosmographRef.current?.deactivatePolygonalSelection?.()
    isLassoActiveRef.current = false
    setIsLassoActive(false)
    onSelectionChangeRef.current(
      nodeIds.length > 0 ? { source: "lasso", nodeIds } : null,
    )
  }, [])

  const readLassoSelection = useCallback(
    (attemptsRemaining: number) => {
      if (!isLassoActiveRef.current) return

      const selectedIndices =
        cosmographRef.current?.getSelectedPointIndices?.() ?? []
      if (selectedIndices.length > 0 || attemptsRemaining <= 0) {
        emitLassoSelection(selectedIndices)
        return
      }

      window.requestAnimationFrame(() =>
        readLassoSelection(attemptsRemaining - 1),
      )
    },
    [emitLassoSelection],
  )

  const handlePolygonSelected = useCallback(
    (_polygonPoints: [number, number][]) => {
      // Cosmograph applies polygon selection before notifying us, but unlike
      // rect selection it does not pass indices in the callback. Read back the
      // committed selection over a few frames; crossfilter can report before
      // Cosmos exposes selected indices.
      readLassoSelection(6)
    },
    [readLassoSelection],
  )

  useImperativeHandle(
    ref,
    () => ({
      fitView: () => {
        cosmographRef.current?.fitView?.(400)
      },
      fitToIds: (ids: string[], options?: FitToIdsOptions) => {
        const indices = getPointIndicesForIds(ids)
        if (indices.length) {
          const getPosition = (index: number) =>
            cosmographRef.current?.getPointPositionByIndex?.(index)
          const { coordinates, indices: fitIndices } = buildFocusFitTarget(
            indices,
            getPosition,
            options,
          )
          if (coordinates.length >= 4) {
            cosmographRef.current?.fitViewByCoordinates?.(
              coordinates,
              600,
              options?.padding ?? FOCUS_FIT_PADDING,
            )
            return
          }
          cosmographRef.current?.fitViewByIndices?.(
            fitIndices,
            600,
            options?.padding ?? FOCUS_FIT_PADDING,
          )
        }
      },
      focusNode: (id: string) => {
        const index = pointIndexByIdRef.current.get(id)
        if (index !== undefined) {
          cosmographRef.current?.fitViewByIndices?.([index], 500)
        }
      },
      focusNeighbourhood: (id: string) => {
        const index = pointIndexByIdRef.current.get(id)
        if (index === undefined) return
        const adj =
          cosmographRef.current?.getConnectedPointIndices?.(index) ?? []
        cosmographRef.current?.fitViewByIndices?.([index, ...adj], 700)
      },
      selectPoints: (ids: string[]) => {
        const indices = getPointIndicesForIds(ids)
        cosmographRef.current?.selectPoints?.(indices.length ? indices : [])
      },
      selectPointsWithAdjacentEdges: (ids: string[]) => {
        const indices = new Set<number>()
        for (const index of getPointIndicesForIds(ids)) {
          indices.add(index)
          const adjacent =
            cosmographRef.current?.getConnectedPointIndices?.(index) ?? []
          for (const adjacentIndex of adjacent) indices.add(adjacentIndex)
        }
        cosmographRef.current?.selectPoints?.(
          indices.size ? Array.from(indices) : [],
        )
      },
      selectNeighbourhood: (id: string) => {
        const index = pointIndexByIdRef.current.get(id)
        if (index === undefined) return
        const adj =
          cosmographRef.current?.getConnectedPointIndices?.(index) ?? []
        cosmographRef.current?.selectPoints?.([index, ...adj])
      },
      unselectAll: () => {
        cosmographRef.current?.unselectAllPoints?.()
      },
      clearSelectionFilters,
    }),
    [clearSelectionFilters, getPointIndicesForIds],
  )

  useEffect(() => {
    if (points.length === 0) {
      setConfig(null)
      setPrepStage("idle")
      setPrepError(null)
      pointIdsRef.current = []
      pointIndexByIdRef.current = new Map()
      return
    }

    hasInitialFitRef.current = false
    setIsSimulationRunning(false)
    isLassoActiveRef.current = false
    setIsLassoActive(false)
    setIsSettled(false)
    setPrepStage("preparing")
    setPrepError(null)
    pointIdsRef.current = points.map((p) => p.id)
    pointIndexByIdRef.current = new Map(
      pointIdsRef.current.map((id, index) => [id, index]),
    )
    let cancelled = false
    let fitFallbackTimer: ReturnType<typeof setTimeout> | null = null
    let revealTimer: ReturnType<typeof setTimeout> | null = null

    async function load() {
      const hasEdges = links.length > 0

      const prepConfig = {
        points: {
          pointIdBy: "id",
          pointLabelBy: "label",
          pointColorBy: "kind",
          pointColorPalette: [...KIND_PALETTE],
          pointSizeBy: "degree",
          pointClusterBy: "kind",
          pointIncludeColumns: ["id", "label", "kind", "summary", "degree"],
        },
        ...(hasEdges
          ? {
              links: {
                linkSourceBy: "source",
                linkTargetsBy: ["target" as const],
                linkColorBy: "predicate",
                linkWidthBy: "confidence",
                linkIncludeColumns: [
                  "predicate",
                  "confidence",
                  "lastObservedAt",
                  "lastObservedAtMs",
                ],
              },
            }
          : {}),
      } as CosmographDataPrepConfig

      let result: Awaited<ReturnType<typeof prepareCosmographData>>
      try {
        result = await prepareCosmographData(
          prepConfig,
          points,
          hasEdges ? links : undefined,
        )
      } catch (err) {
        if (!cancelled) {
          setPrepStage("error")
          setPrepError(err instanceof Error ? err.message : String(err))
        }
        return
      }

      if (cancelled) return
      if (!result) {
        setPrepStage("error")
        setPrepError("Cosmograph returned no data to render.")
        return
      }

      const { points: prepPoints, links: prepLinks, cosmographConfig } = result

      const fitGraphExtents = (duration = 0) => {
        cosmographRef.current?.fitView?.(duration, INITIAL_EXTENTS_FIT_PADDING)
      }
      const revealAfterInitialFit = () => {
        if (revealTimer) clearTimeout(revealTimer)
        revealTimer = setTimeout(() => setIsSettled(true), REVEAL_AFTER_FIT_MS)
      }

      const n = points.length
      const isLargeGraph = n > 20_000
      setConfig({
        points: prepPoints,
        links: prepLinks,
        ...cosmographConfig,
        ...GRAPH_SIMULATION_PRESET,
        pointDefaultColor: KIND_FALLBACK_COLOR,
        pointDefaultSize: 7,
        pointSizeRange: isLargeGraph ? [1, 22] : [4, 12],
        linkDefaultColor: LINK_BASE,
        linkDefaultWidth: isLargeGraph ? 0.5 : 0.8,
        linkWidthRange: isLargeGraph ? [0.25, 2.8] : [0.5, 3.2],
        linkWidthStrategy: "average",
        hoveredLinkColor: "#f8fafc",
        hoveredLinkWidthIncrease: isLargeGraph ? 1.8 : 2.4,
        backgroundColor: PAGE_BG,
        fitViewOnInit: false,
        preservePointPositionsOnDataUpdate: true,
        pixelRatio: isLargeGraph
          ? 1
          : Math.min(
              typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
              2,
            ),
        focusPointOnClick: true,
        selectPointOnClick: true,
        selectPointOnLabelClick: true,
        selectClusterOnLabelClick: true,
        showLabels: true,
        showClusterLabels: true,
        pointLabelWeightBy: "degree",
        showTopLabelsLimit: isLargeGraph ? 24 : 40,
        showDynamicLabelsLimit: isLargeGraph ? 20 : 40,
        showUnselectedPointLabels: false,
        usePointColorStrategyForClusterLabels: true,
        clusterLabelClassName:
          "background: none; font-family: var(--font-geist-sans); font-weight: 500; letter-spacing: -0.02em; opacity: 0.9;",
        pointGreyoutOpacity: 0.15,
        disableLogging: import.meta.env.PROD,
        unknownColor: UNKNOWN_COLOR,
        fitViewPadding: 0.15,
        onSimulationStart: () => {
          setIsSimulationRunning(true)
        },
        onSimulationEnd: () => {
          setIsSimulationRunning(false)
          if (hasInitialFitRef.current) return
          hasInitialFitRef.current = true
          fitGraphExtents()
          revealAfterInitialFit()
        },
        onGraphRebuilt: () => {
          if (fitFallbackTimer) clearTimeout(fitFallbackTimer)
          fitFallbackTimer = setTimeout(() => {
            if (!hasInitialFitRef.current) {
              hasInitialFitRef.current = true
              fitGraphExtents()
              revealAfterInitialFit()
            }
          }, REVEAL_AFTER_REBUILD_MS)
        },
        onClick: (index: number | undefined) => {
          handleCanvasPointIndex(index)
        },
        onLabelClick: (_index: number, id: string) => {
          onPointClickRef.current(id)
        },
        onPointsFiltered: (_filteredPoints, selectedPointIndices) => {
          if (
            isLassoActiveRef.current &&
            selectedPointIndices &&
            selectedPointIndices.length > 0
          ) {
            emitLassoSelection(selectedPointIndices)
          }
        },
        onPolygonSelected: (polygonPoints: [number, number][]) => {
          handlePolygonSelected(polygonPoints)
        },
      })
    }

    void load()

    return () => {
      cancelled = true
      if (fitFallbackTimer) clearTimeout(fitFallbackTimer)
      if (revealTimer) clearTimeout(revealTimer)
    }
  }, [
    points,
    links,
    handleCanvasPointIndex,
    emitLassoSelection,
    handlePolygonSelected,
  ])

  if (!config) {
    /* Visible state so the user isn't staring at a black screen if
     * `prepareCosmographData` throws or silently returns nothing. */
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-2"
        style={{ backgroundColor: PAGE_BG }}
      >
        {prepStage === "preparing" ? (
          <>
            <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.24em] text-teal-400">
              <span className="inline-block h-2 w-2 animate-pulse bg-teal-400" />
              <span>Preparing graph data</span>
            </div>
            <p className="text-[12px] text-zinc-500 tabular-nums">
              {points.length.toLocaleString()} nodes ·{" "}
              {links.length.toLocaleString()} edges
            </p>
          </>
        ) : null}
        {prepStage === "error" ? (
          <div className="max-w-md border border-red-500/35 bg-red-950/40 px-4 py-3 text-[13px] text-red-200">
            <p className="font-semibold uppercase tracking-[0.14em] text-red-300">
              Graph prep failed
            </p>
            <p className="mt-2 break-words">{prepError}</p>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <CosmographProvider>
      <div
        className="absolute inset-0 h-full min-h-0 w-full min-w-0 outline-none transition-opacity duration-300 ease-out [&_canvas]:outline-none [&_canvas]:focus:outline-none [&_canvas]:focus-visible:outline-none motion-reduce:transition-none"
        style={{
          backgroundColor: PAGE_BG,
          opacity: isSettled ? 1 : 0,
        }}
      >
        <Cosmograph
          ref={cosmographRef}
          className="absolute inset-0 h-full min-h-0 w-full min-w-0 outline-none"
          style={{
            backgroundColor: PAGE_BG,
            outline: "none",
            touchAction: "none",
          }}
          {...config}
        />
      </div>
      {isSettled ? (
        <>
          <div className="pointer-events-auto absolute left-2 top-2 z-10 flex flex-col gap-2">
            <ToolRail>
              <GraphControlButton
                active={isLassoActive}
                label={isLassoActive ? "Return to cursor" : "Lasso select"}
                onClick={toggleLasso}
              >
                <LassoIcon />
              </GraphControlButton>
              <GraphControlButton
                label={isSimulationRunning ? "Pause layout" : "Play layout"}
                onClick={toggleSimulation}
              >
                {isSimulationRunning ? <PauseIcon /> : <PlayIcon />}
              </GraphControlButton>
              <GraphControlButton
                label="Reset selections"
                onClick={() => {
                  clearSelectionFilters()
                  onBackgroundClickRef.current()
                }}
              >
                <ClearIcon />
              </GraphControlButton>
              <GraphControlButton
                label="Capture screenshot"
                onClick={() =>
                  cosmographRef.current?.captureScreenshot(
                    "ctxpipe-knowledge-graph.png",
                  )
                }
              >
                <CameraIcon />
              </GraphControlButton>
            </ToolRail>
            <ToolRail>
              <GraphControlButton
                label="Zoom in"
                onClick={() => {
                  const zoom = cosmographRef.current?.getZoomLevel?.() ?? 1
                  cosmographRef.current?.setZoomLevel?.(zoom * 1.25, 180)
                }}
              >
                <ZoomInIcon />
              </GraphControlButton>
              <GraphControlButton
                label="Zoom out"
                onClick={() => {
                  const zoom = cosmographRef.current?.getZoomLevel?.() ?? 1
                  cosmographRef.current?.setZoomLevel?.(zoom / 1.25, 180)
                }}
              >
                <ZoomOutIcon />
              </GraphControlButton>
              <GraphControlButton
                label="Reset view"
                onClick={() => cosmographRef.current?.fitView?.(300, 0.15)}
              >
                <ResetViewIcon />
              </GraphControlButton>
            </ToolRail>
          </div>

          {degreeLegend ? <LegendDock legend={degreeLegend} /> : null}

          <div className="pointer-events-auto absolute left-1/2 top-2 z-10 flex h-10 w-[min(40rem,calc(100vw-8rem))] -translate-x-1/2 items-stretch gap-3 max-sm:w-[calc(100vw-4rem)]">
            <div className="min-w-0 flex-1 border border-zinc-800/95 bg-zinc-950/88 px-3 py-1.5 shadow-xl shadow-black/30 backdrop-blur">
              <FallbackGraphSearch
                points={points}
                onFocusIds={focusSearchIds}
              />
            </div>
            {centerControls ? (
              <div className="flex items-center" aria-hidden>
                <div className="h-5 w-px bg-zinc-800/95" />
              </div>
            ) : null}
            {centerControls}
          </div>

          <div className="pointer-events-auto absolute bottom-2 left-2 right-2 z-10">
            <StockPanel className="px-2 py-1">
              <NativeObservationTimeline
                ref={timelineRef}
                onAnimationPause={handleTimelineAnimationPause}
                onSelectionChange={handleTimelineSelection}
              />
              {footerMetadata ? (
                <div className="mt-1 border-t border-zinc-800/60 pt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-600">
                  {footerMetadata}
                </div>
              ) : null}
            </StockPanel>
          </div>
        </>
      ) : null}
      <LayoutProgressOverlay
        hidden={isSettled}
        nodeCount={points.length}
        edgeCount={links.length}
        estimatedMs={REVEAL_AFTER_REBUILD_MS + REVEAL_AFTER_FIT_MS}
      />
    </CosmographProvider>
  )
})

function FallbackGraphSearch({
  points,
  onFocusIds,
}: {
  points: GraphPointRow[]
  onFocusIds: (ids: string[]) => void
}) {
  const [query, setQuery] = useState("")
  const trimmed = query.trim().toLowerCase()
  const searchIndex = useMemo(
    () =>
      points.map((point) => ({
        point,
        searchText: [point.id, point.label, point.kind, point.summary]
          .join(" ")
          .toLowerCase(),
      })),
    [points],
  )
  const matches = useMemo(() => {
    if (!trimmed) return []
    return searchIndex
      .filter((entry) => entry.searchText.includes(trimmed))
      .map((entry) => entry.point)
      .slice(0, 8)
  }, [searchIndex, trimmed])

  const focusMatches = () => {
    if (matches.length === 0) return
    onFocusIds(matches.map((point) => point.id))
  }

  return (
    <div className="relative w-full">
      <label htmlFor="kg-fallback-search" className="sr-only">
        Search nodes
      </label>
      <input
        id="kg-fallback-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") focusMatches()
        }}
        placeholder="Search nodes"
        className="h-8 w-full border-0 bg-transparent pr-2 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      {trimmed ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto border border-zinc-800 bg-zinc-950/95 p-1 shadow-xl shadow-black/40 backdrop-blur-md">
          {matches.length > 0 ? (
            <>
              <button
                type="button"
                onClick={focusMatches}
                className="mb-1 w-full border border-teal-500/30 bg-teal-500/10 px-2 py-1.5 text-left text-[12px] text-teal-200 hover:bg-teal-500/15"
              >
                Focus {matches.length.toLocaleString()} result
                {matches.length === 1 ? "" : "s"}
              </button>
              {matches.map((point) => (
                <button
                  key={point.id}
                  type="button"
                  onClick={() => onFocusIds([point.id])}
                  className="block w-full px-2 py-1.5 text-left hover:bg-white/5"
                >
                  <span className="block truncate text-[13px] text-zinc-100">
                    {point.label}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {point.kind}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <p className="px-2 py-1.5 text-[12px] text-zinc-500">
              No matching nodes
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

type DegreeLegend = {
  min: number
  max: number
}

function buildDegreeLegend(points: GraphPointRow[]): DegreeLegend | null {
  if (points.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const degree = point.degree
    if (!Number.isFinite(degree)) continue
    if (degree < min) min = degree
    if (degree > max) max = degree
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return { min, max }
}

function LegendDock({ legend }: { legend: DegreeLegend }) {
  return (
    <div className="pointer-events-none absolute right-3 bottom-[5.75rem] left-3 z-10 flex h-[4.625rem] items-stretch justify-between gap-4">
      <NodeColorLegend />
      <GraphSizeLegend legend={legend} />
    </div>
  )
}

function NodeColorLegend() {
  return (
    <div className="pointer-events-auto flex h-full w-64 max-w-[calc(50vw-1.5rem)] flex-col justify-between border border-zinc-800/70 bg-zinc-950/55 px-3 py-2 text-zinc-500 shadow-xl shadow-black/30 backdrop-blur-sm">
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2 font-mono text-[11px] leading-none">
        <div className="text-left">
          <div className="text-zinc-400">Node</div>
          <div className="mt-0.5 text-[11px] text-zinc-600">kind</div>
        </div>
        <div className="pt-[0.9rem] text-center text-[11px] text-zinc-400">
          node colours
        </div>
        <div className="text-right">
          <div className="tabular-nums text-zinc-400">
            {KIND_PALETTE.length.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-600">colours</div>
        </div>
      </div>
      <div
        className="h-1.5 w-full"
        style={{
          background: `linear-gradient(90deg, ${KIND_PALETTE.join(", ")})`,
        }}
        aria-label="Node colour palette"
        role="img"
      />
    </div>
  )
}

function GraphSizeLegend({ legend }: { legend: DegreeLegend }) {
  const lowLabel = legend.min <= 1 ? "1 and less" : `${legend.min} and less`
  const highLabel = `${legend.max} and more`

  return (
    <div
      className="pointer-events-auto grid h-full w-[22rem] max-w-[calc(50vw-1.5rem)] grid-cols-[9.5rem_10.5rem] justify-between border border-zinc-800/70 bg-zinc-950/55 px-3 py-2 text-zinc-500 shadow-xl shadow-black/30 backdrop-blur-sm"
      aria-label={`Edge width shows relationship confidence. Node size shows connections count from ${lowLabel} to ${highLabel}`}
      role="img"
    >
      <div className="flex min-w-0 flex-col justify-between font-mono leading-none">
        <div className="grid grid-cols-2 gap-2">
          <LegendLineSample thickness={1} value="low" caption="confidence" />
          <LegendLineSample thickness={4} value="high" caption="confidence" />
        </div>
        <div className="whitespace-nowrap text-center text-[11px] text-zinc-400">
          edge width
        </div>
      </div>
      <div className="flex min-w-0 flex-col justify-between font-mono leading-none">
        <div className="grid grid-cols-2 gap-2">
          <LegendDotSample
            sizeClass="h-1.5 w-1.5"
            value={legend.min.toLocaleString()}
            caption="and less"
          />
          <LegendDotSample
            sizeClass="h-3 w-3"
            value={legend.max.toLocaleString()}
            caption="and more"
          />
        </div>
        <div className="whitespace-nowrap text-center text-[11px] text-zinc-400">
          connections count
        </div>
      </div>
    </div>
  )
}

function LegendLineSample({
  caption,
  thickness,
  value,
}: {
  caption: string
  thickness: number
  value: string
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="flex h-4 items-center" aria-hidden>
        <span
          className="block w-8 bg-zinc-300"
          style={{ height: `${thickness}px` }}
        />
      </span>
      <span className="text-[11px] text-zinc-400">{value}</span>
      <span className="mt-0.5 whitespace-nowrap text-[11px] text-zinc-600">
        {caption}
      </span>
    </div>
  )
}

function LegendDotSample({
  caption,
  sizeClass,
  value,
}: {
  caption: string
  sizeClass: string
  value: string
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="flex h-4 items-center justify-center">
        <span className={`block rounded-full bg-zinc-300 ${sizeClass}`} />
      </span>
      <span className="text-[11px] tabular-nums text-zinc-400">{value}</span>
      <span className="mt-0.5 whitespace-nowrap text-[11px] text-zinc-600">
        {caption}
      </span>
    </div>
  )
}

const NativeObservationTimeline = forwardRef<
  CosmographTimelineRef,
  {
    onAnimationPause: (
      isAnimationRunning: boolean,
      selection: TimelineSelection,
    ) => void
    onSelectionChange: (selection: TimelineSelection) => void
  }
>(function NativeObservationTimeline(
  { onAnimationPause, onSelectionChange },
  ref,
) {
  const timelineStyle = {
    height: "48px",
    "--cosmograph-timeline-background": "transparent",
    "--cosmograph-timeline-bar-color": "rgba(113, 113, 122, 0.58)",
    "--cosmograph-timeline-highlighted-bar-color": "rgba(212, 212, 216, 0.5)",
    "--cosmograph-timeline-text-color": "rgb(82, 82, 91)",
    "--cosmograph-timeline-axis-color": "rgb(82, 82, 91)",
    "--cosmograph-timeline-selection-color": "rgba(45, 212, 191, 0.55)",
    "--cosmograph-timeline-selection-opacity": "0.28",
    "--cosmograph-ui-tick-font-size": "11px",
  } as CSSProperties

  return (
    <div className="h-12 overflow-hidden px-1">
      <CosmographTimeline
        ref={ref}
        className="h-full min-h-0 w-full overflow-hidden [&_svg]:h-full [&_svg]:w-full"
        style={timelineStyle}
        accessor="lastObservedAtMs"
        useLinksData
        id="knowledge-graph-observed-at"
        preserveSelectionOnUnmount
        allowSelection
        barCount={180}
        barPadding={0.08}
        barRadius={0}
        barTopMargin={14}
        minBarHeight={1}
        axisTickHeight={12}
        padding={{ top: 1, right: 5, bottom: 1, left: 5 }}
        selectionPadding={2}
        selectionRadius={0}
        highlightSelectedData={false}
        showAnimationControls
        onSelection={onSelectionChange}
        onAnimationTick={onSelectionChange}
        onAnimationPause={onAnimationPause}
        formatter={(value) =>
          new Date(value).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
          })
        }
      />
    </div>
  )
})

function StockPanel({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-none border border-zinc-800/95 bg-zinc-950/90 p-3 text-zinc-200 shadow-xl shadow-black/40 backdrop-blur-md ${className}`}
    >
      {children}
    </div>
  )
}

function GraphControlButton({
  active = false,
  children,
  label,
  onClick,
}: {
  active?: boolean
  children: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center transition-colors hover:bg-white/5 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-teal-400/70 ${
        active ? "bg-teal-400/10 text-teal-200" : "text-zinc-500"
      }`}
    >
      {children}
    </button>
  )
}

function ToolRail({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-9 flex-col items-center gap-1 border border-zinc-800/80 bg-zinc-950/55 p-1 text-zinc-500 shadow-xl shadow-black/30 backdrop-blur-sm">
      {children}
    </div>
  )
}

function PlayIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="currentColor"
    >
      <title>Play layout</title>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="currentColor"
    >
      <title>Pause layout</title>
      <path d="M7 5h4v14H7z" />
      <path d="M13 5h4v14h-4z" />
    </svg>
  )
}

function LassoIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      <title>Lasso select</title>
      <path d="M6 6c4-3 12-1 13 4 1 4-4 7-9 6-5-1-7-6-4-10Z" />
      <path d="M7 16 5 21" />
      <path d="m5 21 5-2" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      <title>Reset selections</title>
      <path d="m5 5 14 14" />
      <path d="M8 4h8a4 4 0 0 1 4 4v8" />
      <path d="M16 20H8a4 4 0 0 1-4-4V8" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      <title>Capture screenshot</title>
      <path d="M14.5 4.5 16 7h3a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-2.5h5Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  )
}

function ZoomInIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    >
      <title>Zoom in</title>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function ZoomOutIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
    >
      <title>Zoom out</title>
      <path d="M5 12h14" />
    </svg>
  )
}

function ResetViewIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      <title>Reset view</title>
      <path d="M8 4H4v4" />
      <path d="M16 4h4v4" />
      <path d="M20 16v4h-4" />
      <path d="M4 16v4h4" />
    </svg>
  )
}

/** Rotating phase labels — pure cosmetics; the real simulation doesn't expose
 * staged progress, but the rotation gives the user a "something's happening"
 * signal without lying about percentage. */
const LAYOUT_PHASES = [
  "Preparing force simulation",
  "Computing node positions",
  "Clustering connected components",
  "Settling layout",
]
const PHASE_ROTATION_MS = 2800

/** Thin wrapper around the shared `ProgressLoader` that manages the elapsed
 * timer + phase rotation for the brief first-fit window. We hide only the
 * initial random scramble, then reveal while Cosmograph continues simulating. */
function LayoutProgressOverlay({
  hidden,
  nodeCount,
  edgeCount,
  estimatedMs,
}: {
  hidden: boolean
  nodeCount: number
  edgeCount: number
  estimatedMs: number
}) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (hidden) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    const id = window.setInterval(() => {
      setElapsed(Date.now() - start)
    }, 120)
    return () => window.clearInterval(id)
  }, [hidden])

  // Clamp at 99% so the bar never reads as "done" before the reveal fires.
  const progress = Math.min(99, (elapsed / estimatedMs) * 100)
  const phase =
    LAYOUT_PHASES[
      Math.min(
        LAYOUT_PHASES.length - 1,
        Math.floor(elapsed / PHASE_ROTATION_MS),
      )
    ] ?? LAYOUT_PHASES[0]
  const sublabel =
    nodeCount > 0
      ? `${nodeCount.toLocaleString()} nodes · ${edgeCount.toLocaleString()} edges · ${(elapsed / 1000).toFixed(1)} s`
      : undefined

  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300 ease-out motion-reduce:transition-none"
      style={{
        backgroundColor: PAGE_BG,
        opacity: hidden ? 0 : 1,
      }}
      aria-hidden
    >
      <ProgressLoader
        label={phase ?? "Laying out graph"}
        sublabel={sublabel}
        progress={progress}
      />
    </div>
  )
}
