import { useCallback, useEffect, useRef, useState } from "react"
import {
  Cosmograph,
  prepareCosmographData,
  type CosmographConfig,
  type CosmographRef,
} from "@cosmograph/react"
import { ENTITY_COLORS, STUB_LINKS, STUB_NODES, type EntityType } from "./stub-data"

type GraphStats = {
  nodeCount: number
  edgeCount: number
}

function getMatchingIds(
  query: string,
  nodes: typeof STUB_NODES = STUB_NODES,
): string[] {
  const q = query.toLowerCase()
  return nodes
    .filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q) ||
        (n.description?.toLowerCase().includes(q) ?? false) ||
        (n.repository?.toLowerCase().includes(q) ?? false),
    )
    .map((n) => n.id)
}

export function GraphVisualization() {
  const cosmographRef = useRef<CosmographRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig>({})
  const [stats, setStats] = useState<GraphStats>({ nodeCount: 0, edgeCount: 0 })
  const [searchQuery, setSearchQuery] = useState("")
  const [matchCount, setMatchCount] = useState<number | null>(null)
  const [hiddenTypes, setHiddenTypes] = useState<Set<EntityType>>(new Set())
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guard so fitView only runs once on initial layout — not on every subsequent
  // simulation restart triggered by selectPoints/unselectAllPoints calls.
  const hasInitialFitRef = useRef(false)

  useEffect(() => {
    async function load() {
      const result = await prepareCosmographData(
        {
          points: { pointIdBy: "id" },
          links: {
            linkSourceBy: "source",
            linkTargetsBy: ["target"],
          },
        },
        STUB_NODES,
        STUB_LINKS,
      )
      if (!result) return

      const { points, links, cosmographConfig } = result

      setConfig({
        ...cosmographConfig,
        points,
        links,
        pointColorBy: "color",
        pointSizeBy: "size",
        linkDefaultColor: "rgba(255,255,255,0.10)",
        linkDefaultWidth: 1,
        backgroundColor: "transparent",
        selectPointOnClick: "single",
        pointGreyoutOpacity: 0.04,
        linkGreyoutOpacity: 0.02,
        onGraphRebuilt: ({ pointsCount, linksCount }) => {
          setStats({ nodeCount: pointsCount, edgeCount: linksCount })
        },
        onSimulationEnd: () => {
          if (!hasInitialFitRef.current) {
            hasInitialFitRef.current = true
            cosmographRef.current?.fitView(600)
          }
        },
      })
    }

    load()
  }, [])

  const clearSearch = useCallback(() => {
    setSearchQuery("")
    setMatchCount(null)
    // Only fully unselect if there are no type filters keeping a selection active
    if (hiddenTypes.size === 0) {
      cosmographRef.current?.unselectAllPoints()
    }
  }, [hiddenTypes.size])

  // Combined filter effect: search (debounced) + type visibility (immediate)
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)

    const hasSearch = searchQuery.trim().length > 0
    const hasTypeFilter = hiddenTypes.size > 0

    if (!hasSearch && !hasTypeFilter) {
      cosmographRef.current?.unselectAllPoints()
      setMatchCount(null)
      return
    }

    async function apply() {
      const visibleNodes =
        hiddenTypes.size > 0
          ? STUB_NODES.filter((n) => !hiddenTypes.has(n.type))
          : STUB_NODES

      const ids = hasSearch ? getMatchingIds(searchQuery, visibleNodes) : visibleNodes.map((n) => n.id)

      if (hasSearch) setMatchCount(ids.length)

      if (ids.length === 0) {
        cosmographRef.current?.unselectAllPoints()
        return
      }

      const indices = await cosmographRef.current?.getPointIndicesByIds(ids)
      if (!indices) return

      cosmographRef.current?.selectPoints(indices)
      if (hasSearch && ids.length <= 200) {
        cosmographRef.current?.fitViewByIndices(indices, 600)
      }
    }

    if (hasSearch) {
      // Debounce text input; type toggles apply immediately
      searchDebounceRef.current = setTimeout(apply, 280)
    } else {
      apply()
    }

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery, hiddenTypes])

  const toggleType = useCallback((type: EntityType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  // Compute active selection IDs for "Fit to selection" (respects both filters)
  function getSelectionIds() {
    const visibleNodes =
      hiddenTypes.size > 0
        ? STUB_NODES.filter((n) => !hiddenTypes.has(n.type))
        : STUB_NODES
    return searchQuery.trim()
      ? getMatchingIds(searchQuery, visibleNodes)
      : visibleNodes.map((n) => n.id)
  }

  const hasActiveFilter = searchQuery.trim().length > 0 || hiddenTypes.size > 0

  return (
    <div className="relative h-full w-full">
      {/* Metrics */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex gap-3">
        <MetricChip label="Nodes" value={stats.nodeCount || STUB_NODES.length} />
        <MetricChip label="Edges" value={stats.edgeCount || STUB_LINKS.length} />
      </div>

      {/* Search */}
      <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 focus-within:border-teal-500/40">
          <svg
            className="h-3.5 w-3.5 shrink-0 text-zinc-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 1 0 6.5 6.5a7.5 7.5 0 0 0 10.15 10.15z"
            />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && clearSearch()}
            placeholder="Search nodes by name, type, or repo…"
            className="w-64 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
          {searchQuery && (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs tabular-nums text-zinc-400">
                {matchCount === null
                  ? "…"
                  : `${matchCount.toLocaleString()} match${matchCount !== 1 ? "es" : ""}`}
              </span>
              <button
                onClick={clearSearch}
                aria-label="Clear search"
                className="text-zinc-500 transition-colors hover:text-zinc-200"
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Legend — click to toggle type visibility */}
      <div className="absolute right-4 top-4 z-10 flex flex-col gap-0.5 rounded-lg border border-white/8 bg-zinc-900 p-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          Node types
        </p>
        {(Object.entries(ENTITY_COLORS) as [EntityType, string][]).map(([type, color]) => {
          const isHidden = hiddenTypes.has(type)
          return (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={[
                "flex items-center gap-2 rounded px-1 py-0.5 transition-opacity hover:bg-white/5",
                isHidden ? "opacity-35" : "",
              ].join(" ")}
              aria-pressed={!isHidden}
              aria-label={`${isHidden ? "Show" : "Hide"} ${type} nodes`}
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full transition-colors"
                style={{ backgroundColor: isHidden ? "#52525b" : color }}
              />
              <span
                className={[
                  "text-xs transition-colors",
                  isHidden ? "text-zinc-600 line-through" : "text-zinc-300",
                ].join(" ")}
              >
                {type}
              </span>
            </button>
          )
        })}
        {hiddenTypes.size > 0 && (
          <button
            onClick={() => setHiddenTypes(new Set())}
            className="mt-1.5 text-left text-[10px] text-teal-500 hover:text-teal-400"
          >
            Show all
          </button>
        )}
      </div>

      {/* Map controls */}
      <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1">
        {hasActiveFilter && (matchCount === null || matchCount > 0) && (
          <MapControlButton
            onClick={() => {
              cosmographRef.current
                ?.getPointIndicesByIds(getSelectionIds())
                .then((indices) => {
                  if (indices) cosmographRef.current?.fitViewByIndices(indices, 600)
                })
            }}
            label="Fit to selection"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
              />
            </svg>
          </MapControlButton>
        )}
        <MapControlButton
          onClick={() => cosmographRef.current?.fitView(400)}
          label="Fit view"
        >
          ⤢
        </MapControlButton>
      </div>

      {/* Black-out overlay when search has no results */}
      {searchQuery.trim() && matchCount === 0 && (
        <div className="pointer-events-none absolute inset-0 z-[5] bg-zinc-950/95" />
      )}

      <Cosmograph ref={cosmographRef} {...config} />
    </div>
  )
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/8 bg-zinc-900 px-3 py-2">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="font-mono text-lg font-semibold tabular-nums text-zinc-100">
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
    <button
      onClick={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded border border-white/10 bg-zinc-900 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
    >
      {children}
    </button>
  )
}
