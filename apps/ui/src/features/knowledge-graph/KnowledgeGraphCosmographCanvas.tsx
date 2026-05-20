import {
  Cosmograph,
  type CosmographConfig,
  type CosmographDataPrepConfig,
  CosmographProvider,
  type CosmographRef,
  prepareCosmographData,
} from "@cosmograph/react"
import {
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
}

const REVEAL_AFTER_FIT_MS = 80
const FOCUS_FIT_PADDING = 0.12

/** Fallback reveal when `onSimulationEnd` never fires. Kept short even for big
 * graphs — Cosmograph's sim runs live after reveal, so a not-yet-settled layout
 * visibly drifts into place rather than hiding behind a 30s overlay. */
function settleFallbackMs(n: number): number {
  if (n < 5_000) return 1200
  if (n < 50_000) return 2500
  return 5000
}

/** Hides the early simulation scramble behind an overlay and reveals only the
 * settled, fitted layout. */
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
  },
  ref,
) {
  const cosmographRef = useRef<CosmographRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig | null>(null)
  const [isSettled, setIsSettled] = useState(false)
  const [isSimulationRunning, setIsSimulationRunning] = useState(false)
  const [prepStage, setPrepStage] = useState<"idle" | "preparing" | "error">(
    "idle",
  )
  const [prepError, setPrepError] = useState<string | null>(null)
  const hasInitialFitRef = useRef(false)
  const pointIdsRef = useRef<string[]>([])
  const onPointClickRef = useRef(onPointClick)
  const onBackgroundClickRef = useRef(onBackgroundClick)
  onPointClickRef.current = onPointClick
  onBackgroundClickRef.current = onBackgroundClick

  const handleCanvasPointIndex = useCallback((index: number | undefined) => {
    if (index === undefined) {
      onBackgroundClickRef.current()
      return
    }
    onPointClickRef.current(pointIdsRef.current[index] ?? null)
  }, [])

  const focusSearchIds = useCallback((ids: string[]) => {
    const idSet = new Set(ids)
    const indices: number[] = []
    pointIdsRef.current.forEach((id, index) => {
      if (idSet.has(id)) indices.push(index)
    })
    if (indices.length === 0) return
    cosmographRef.current?.selectPoints?.(indices)
    cosmographRef.current?.fitViewByIndices?.(indices, 500, FOCUS_FIT_PADDING)
  }, [])

  const toggleSimulation = useCallback(() => {
    if (isSimulationRunning) {
      cosmographRef.current?.pause?.()
      setIsSimulationRunning(false)
      return
    }
    cosmographRef.current?.start?.(0.35)
    setIsSimulationRunning(true)
  }, [isSimulationRunning])

  useImperativeHandle(
    ref,
    () => ({
      fitView: () => {
        cosmographRef.current?.fitView?.(400)
      },
      fitToIds: (ids: string[], options?: FitToIdsOptions) => {
        const idSet = new Set(ids)
        const indices: number[] = []
        pointIdsRef.current.forEach((id, index) => {
          if (idSet.has(id)) indices.push(index)
        })
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
        const index = pointIdsRef.current.indexOf(id)
        if (index >= 0) {
          cosmographRef.current?.fitViewByIndices?.([index], 500)
        }
      },
      focusNeighbourhood: (id: string) => {
        const index = pointIdsRef.current.indexOf(id)
        if (index < 0) return
        const adj =
          cosmographRef.current?.getConnectedPointIndices?.(index) ?? []
        cosmographRef.current?.fitViewByIndices?.([index, ...adj], 700)
      },
      selectPoints: (ids: string[]) => {
        const idSet = new Set(ids)
        const indices: number[] = []
        pointIdsRef.current.forEach((id, index) => {
          if (idSet.has(id)) indices.push(index)
        })
        cosmographRef.current?.selectPoints?.(indices.length ? indices : [])
      },
      selectPointsWithAdjacentEdges: (ids: string[]) => {
        const idSet = new Set(ids)
        const indices = new Set<number>()
        pointIdsRef.current.forEach((id, index) => {
          if (!idSet.has(id)) return
          indices.add(index)
          const adjacent =
            cosmographRef.current?.getConnectedPointIndices?.(index) ?? []
          for (const adjacentIndex of adjacent) indices.add(adjacentIndex)
        })
        cosmographRef.current?.selectPoints?.(
          indices.size ? Array.from(indices) : [],
        )
      },
      selectNeighbourhood: (id: string) => {
        const index = pointIdsRef.current.indexOf(id)
        if (index < 0) return
        const adj =
          cosmographRef.current?.getConnectedPointIndices?.(index) ?? []
        cosmographRef.current?.selectPoints?.([index, ...adj])
      },
      unselectAll: () => {
        cosmographRef.current?.unselectAllPoints?.()
      },
    }),
    [],
  )

  useEffect(() => {
    if (points.length === 0) {
      setConfig(null)
      setPrepStage("idle")
      setPrepError(null)
      pointIdsRef.current = []
      return
    }

    hasInitialFitRef.current = false
    setIsSimulationRunning(false)
    setIsSettled(false)
    setPrepStage("preparing")
    setPrepError(null)
    pointIdsRef.current = points.map((p) => p.id)
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

      const scheduleReveal = () => {
        if (revealTimer) clearTimeout(revealTimer)
        revealTimer = setTimeout(() => setIsSettled(true), REVEAL_AFTER_FIT_MS)
      }

      const n = points.length
      const isLargeGraph = n > 20_000
      setConfig({
        points: prepPoints,
        links: prepLinks,
        ...cosmographConfig,
        pointDefaultColor: KIND_FALLBACK_COLOR,
        pointDefaultSize: 7,
        pointSizeRange: isLargeGraph ? [1, 22] : [4, 12],
        linkDefaultColor: LINK_BASE,
        hoveredLinkColor: "#f8fafc",
        hoveredLinkWidthIncrease: isLargeGraph ? 1.4 : 2.2,
        backgroundColor: PAGE_BG,
        focusPointOnClick: true,
        selectPointOnClick: true,
        selectPointOnLabelClick: true,
        selectClusterOnLabelClick: true,
        showLabels: true,
        showClusterLabels: true,
        showTopLabelsLimit: 40,
        showDynamicLabelsLimit: 40,
        showUnselectedPointLabels: false,
        usePointColorStrategyForClusterLabels: true,
        pointGreyoutOpacity: 0.15,
        disableLogging: import.meta.env.PROD,
        unknownColor: UNKNOWN_COLOR,
        fitViewPadding: 0.15,
        onSimulationEnd: () => {
          setIsSimulationRunning(false)
          if (hasInitialFitRef.current) return
          hasInitialFitRef.current = true
          cosmographRef.current?.fitView?.(0)
          cosmographRef.current?.stop?.()
          scheduleReveal()
        },
        onGraphRebuilt: () => {
          if (fitFallbackTimer) clearTimeout(fitFallbackTimer)
          fitFallbackTimer = setTimeout(() => {
            if (!hasInitialFitRef.current) {
              hasInitialFitRef.current = true
              cosmographRef.current?.fitView?.(0)
              cosmographRef.current?.stop?.()
            }
            setIsSimulationRunning(false)
            setIsSettled(true)
          }, settleFallbackMs(n))
        },
        onClick: (index: number | undefined) => {
          handleCanvasPointIndex(index)
        },
        onPointClick: (index: number | undefined) => {
          handleCanvasPointIndex(index)
        },
        onLabelClick: (_index: number, id: string) => {
          onPointClickRef.current(id)
        },
        onBackgroundClick: () => {
          onBackgroundClickRef.current()
        },
      })
    }

    void load()

    return () => {
      cancelled = true
      if (fitFallbackTimer) clearTimeout(fitFallbackTimer)
      if (revealTimer) clearTimeout(revealTimer)
    }
  }, [points, links, handleCanvasPointIndex])

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
                label="Lasso select"
                onClick={() =>
                  cosmographRef.current?.activatePolygonalSelection?.()
                }
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
                  cosmographRef.current?.unselectAllPoints?.()
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
              <ObservationsTimeline links={links} />
              {footerMetadata ? (
                <div className="mt-1 border-t border-zinc-800/60 pt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
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
        estimatedMs={settleFallbackMs(points.length)}
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
  const matches = useMemo(() => {
    if (!trimmed) return []
    return points
      .filter((point) =>
        [point.id, point.label, point.kind, point.summary]
          .join(" ")
          .toLowerCase()
          .includes(trimmed),
      )
      .slice(0, 8)
  }, [points, trimmed])

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

function ObservationsTimeline({ links }: { links: GraphLinkRow[] }) {
  const timeline = useMemo(() => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let stampCount = 0
    for (const link of links) {
      const stamp = link.lastObservedAtMs
      if (typeof stamp !== "number" || !Number.isFinite(stamp)) continue
      stampCount += 1
      if (stamp < min) min = stamp
      if (stamp > max) max = stamp
    }
    if (stampCount === 0) return null

    const DAY = 24 * 60 * 60 * 1000
    const span = Math.max(max - min, DAY)
    const bucketCount = 180
    const bucketSize = span / bucketCount
    const counts = new Array<number>(bucketCount).fill(0)
    for (const link of links) {
      const stamp = link.lastObservedAtMs
      if (typeof stamp !== "number" || !Number.isFinite(stamp)) continue
      const index = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((stamp - min) / bucketSize)),
      )
      counts[index] += 1
    }
    const maxCount = Math.max(...counts, 1)
    const tickCount = max - min < DAY * 14 ? 2 : 8
    const seenTickLabels = new Set<string>()
    const ticks = Array.from({ length: tickCount }, (_, index) => {
      const ratio = tickCount === 1 ? 0 : index / (tickCount - 1)
      const date = new Date(min + span * ratio)
      const label =
        max - min < DAY * 14
          ? date.toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
            })
          : date.toLocaleDateString(undefined, {
              month: "short",
              year: "2-digit",
            })
      return {
        label,
        ratio,
      }
    }).filter((tick) => {
      if (seenTickLabels.has(tick.label)) return false
      seenTickLabels.add(tick.label)
      return true
    })

    return {
      buckets: counts.map((count, index) => ({
        count,
        id: `${min}-${index}`,
      })),
      maxCount,
      ticks,
    }
  }, [links])

  if (!timeline) {
    return (
      <div className="flex h-12 items-center px-1 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">
        No observation timeline
      </div>
    )
  }

  return (
    <div className="h-12 px-1">
      <div className="relative h-3">
        {timeline.ticks.map((tick) => (
          <span
            key={`${tick.ratio}-${tick.label}`}
            className={`absolute top-0 whitespace-nowrap font-mono text-[8.5px] uppercase tracking-[0.08em] text-zinc-600 ${
              tick.ratio === 0
                ? "translate-x-0 text-left"
                : tick.ratio === 1
                  ? "text-right"
                  : "-translate-x-1/2 text-center"
            }`}
            style={
              tick.ratio === 1 ? { right: 0 } : { left: `${tick.ratio * 100}%` }
            }
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div className="flex h-8 items-end gap-px border-t border-zinc-800/70 pt-1.5">
        {timeline.buckets.map((bucket) => (
          <div
            key={bucket.id}
            className="min-w-0 flex-1 bg-zinc-400/65"
            style={{
              height: `${Math.max(1, (bucket.count / timeline.maxCount) * 100)}%`,
              opacity: bucket.count > 0 ? 0.72 : 0.14,
            }}
          />
        ))}
      </div>
    </div>
  )
}

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
  children,
  label,
  onClick,
}: {
  children: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-teal-400/70"
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
 * timer + phase rotation for the Cosmograph settle window. The outer fading
 * div keeps the full-viewport black background so the in-progress simulation
 * drift isn't visible while still laying out. */
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

  // Clamp at 99% so the bar never reads as "done" before the reveal actually
  // fires. If the real `onSimulationEnd` fires early, `hidden` flips and the
  // whole overlay fades out — no visual jump.
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
