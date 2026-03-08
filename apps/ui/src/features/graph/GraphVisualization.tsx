import { useEffect, useRef, useState } from "react"
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
        // Use the pre-computed `color` field on each node
        pointColorBy: "color",
        // Use the pre-computed `size` field on each node
        pointSizeBy: "size",
        // Link appearance
        linkDefaultColor: "rgba(255,255,255,0.10)",
        linkDefaultWidth: 1,
        // Background transparent (page bg shows through)
        backgroundColor: "transparent",
        // Single-click selection
        selectPointOnClick: "single",
        // Callback to surface counts from rebuilt graph
        onGraphRebuilt: ({ pointsCount, linksCount }) => {
          setStats({ nodeCount: pointsCount, edgeCount: linksCount })
        },
      })
    }

    load()
  }, [])

  return (
    <div className="relative h-full w-full">
      {/* Metrics */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex gap-3">
        <MetricChip label="Nodes" value={stats.nodeCount || STUB_NODES.length} />
        <MetricChip label="Edges" value={stats.edgeCount || STUB_LINKS.length} />
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
