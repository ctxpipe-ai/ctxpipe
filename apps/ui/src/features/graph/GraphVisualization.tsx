import { useCallback, useEffect, useRef, useState } from "react"
import {
  Cosmograph,
  prepareCosmographData,
  type CosmographConfig,
  type CosmographRef,
} from "@cosmograph/react"
import { ENTITY_COLORS, STUB_LINKS, STUB_NODES } from "./stub-data"

type GraphStats = {
  nodeCount: number
  edgeCount: number
}

export function GraphVisualization() {
  const cosmographRef = useRef<CosmographRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig>({})
  const [stats, setStats] = useState<GraphStats>({ nodeCount: 0, edgeCount: 0 })
  const [searchQuery, setSearchQuery] = useState("")
  const [matchCount, setMatchCount] = useState<number | null>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    async function load() {
      const result = await prepareCosmographData(
        {
          points: {
            pointIdBy: "id",
          },
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
        // Dim non-selected nodes/edges when a selection is active
        pointGreyoutOpacity: 0.04,
        linkGreyoutOpacity: 0.02,
        onGraphRebuilt: ({ pointsCount, linksCount }) => {
          setStats({ nodeCount: pointsCount, edgeCount: linksCount })
        },
      })
    }

    load()
  }, [])

  const clearSearch = useCallback(() => {
    setSearchQuery("")
    setMatchCount(null)
    cosmographRef.current?.unselectAllPoints()
  }, [])

  // Debounced search: filter nodes client-side, then pass indices to Cosmograph
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)

    if (!searchQuery.trim()) {
      cosmographRef.current?.unselectAllPoints()
      setMatchCount(null)
      return
    }

    searchDebounceRef.current = setTimeout(async () => {
      const q = searchQuery.toLowerCase()
      const matchingIds = STUB_NODES.filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.type.toLowerCase().includes(q) ||
          (n.description?.toLowerCase().includes(q) ?? false) ||
          (n.repository?.toLowerCase().includes(q) ?? false),
      ).map((n) => n.id)

      setMatchCount(matchingIds.length)

      if (matchingIds.length === 0) {
        cosmographRef.current?.unselectAllPoints()
        return
      }

      const indices = await cosmographRef.current?.getPointIndicesByIds(matchingIds)
      if (!indices) return

      cosmographRef.current?.selectPoints(indices)
      // Zoom to results when set is small enough to be useful
      if (matchingIds.length <= 200) {
        cosmographRef.current?.fitViewByIndices(indices, 600)
      }
    }, 280)

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery])

  return (
    <div className="relative h-full w-full">
      {/* Metrics */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex gap-3">
        <MetricChip label="Nodes" value={stats.nodeCount || STUB_NODES.length} />
        <MetricChip label="Edges" value={stats.edgeCount || STUB_LINKS.length} />
      </div>

      {/* Search */}
      <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/90 px-3 py-2 backdrop-blur focus-within:border-teal-500/40">
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
                {matchCount === null ? "…" : `${matchCount.toLocaleString()} match${matchCount !== 1 ? "es" : ""}`}
              </span>
              <button
                onClick={clearSearch}
                aria-label="Clear search"
                className="text-zinc-500 transition-colors hover:text-zinc-200"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 flex flex-col gap-2 rounded-lg border border-white/8 bg-zinc-900/80 p-3 backdrop-blur">
        {(Object.entries(ENTITY_COLORS) as [keyof typeof ENTITY_COLORS, string][]).map(
          ([type, color]) => (
            <div key={type} className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="text-xs text-zinc-300">{type}</span>
            </div>
          ),
        )}
      </div>

      {/* Map controls */}
      <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1">
        {matchCount !== null && matchCount > 0 && (
          <MapControlButton
            onClick={async () => {
              const ids = STUB_NODES
                .filter((n) => {
                  const q = searchQuery.toLowerCase()
                  return (
                    n.name.toLowerCase().includes(q) ||
                    n.type.toLowerCase().includes(q) ||
                    (n.description?.toLowerCase().includes(q) ?? false) ||
                    (n.repository?.toLowerCase().includes(q) ?? false)
                  )
                })
                .map((n) => n.id)
              const indices = await cosmographRef.current?.getPointIndicesByIds(ids)
              if (indices) cosmographRef.current?.fitViewByIndices(indices, 600)
            }}
            label="Fit to selection"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
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

      <Cosmograph ref={cosmographRef} {...config} />
    </div>
  )
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/8 bg-zinc-900/80 px-3 py-2 backdrop-blur">
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
      className="flex h-8 w-8 items-center justify-center rounded border border-white/10 bg-zinc-900/90 text-sm text-zinc-300 backdrop-blur transition-colors hover:bg-zinc-800 hover:text-zinc-100"
    >
      {children}
    </button>
  )
}
