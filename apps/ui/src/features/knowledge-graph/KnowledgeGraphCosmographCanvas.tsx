import {
  Cosmograph,
  type CosmographConfig,
  type CosmographDataPrepConfig,
  type CosmographRef,
  prepareCosmographData,
} from "@cosmograph/react"
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"

export type KnowledgeGraphCosmographCanvasHandle = {
  fitView: () => void
  fitToIds: (ids: string[]) => void
  focusNode: (id: string) => void
  selectPoints: (ids: string[]) => void
  /** Selects a node + its direct (1-hop) neighbours in Cosmograph so everything
   * else dims — driven by `cosmograph.getConnectedPointIndices`. */
  selectNeighbourhood: (id: string) => void
  unselectAll: () => void
}

/** Rows for `prepareCosmographData`. `color`/`size` are per-element overrides wired
 * via `pointColorBy`/`pointSizeBy`/`linkColorBy` (works once `@luma.gl/*` is pinned to
 * 9.2.6 — see root `package.json` pnpm.overrides; prior mismatch with luma 9.3.x
 * crashed Cosmograph's `_rebuildGraph` through `UniformStore`). */
export type GraphPointRow = {
  id: string
  label: string
  color: string
  size: number
}

export type GraphLinkRow = {
  source: string
  target: string
  color: string
}

type KnowledgeGraphCosmographCanvasProps = {
  points: GraphPointRow[]
  links: GraphLinkRow[]
  /** Invoked with the clicked node's `id` (or `null` on miss). Easier to use than
   * Cosmograph's raw index since the parent works in id-space. */
  onPointClick: (id: string | null) => void
  onBackgroundClick: () => void
}

/** Mounts `<Cosmograph>` only after `prepareCosmographData` resolves; the empty-config
 * first render previously raced the library's async config update. */
export const KnowledgeGraphCosmographCanvas = forwardRef<
  KnowledgeGraphCosmographCanvasHandle,
  KnowledgeGraphCosmographCanvasProps
>(function KnowledgeGraphCosmographCanvas(
  { points, links, onPointClick, onBackgroundClick },
  ref,
) {
  const cosmographRef = useRef<CosmographRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig | null>(null)
  const hasInitialFitRef = useRef(false)
  const pointIdsRef = useRef<string[]>([])
  const onPointClickRef = useRef(onPointClick)
  const onBackgroundClickRef = useRef(onBackgroundClick)
  onPointClickRef.current = onPointClick
  onBackgroundClickRef.current = onBackgroundClick

  useImperativeHandle(
    ref,
    () => ({
      fitView: () => {
        cosmographRef.current?.fitView?.(400)
      },
      fitToIds: (ids: string[]) => {
        const idSet = new Set(ids)
        const indices: number[] = []
        pointIdsRef.current.forEach((id, index) => {
          if (idSet.has(id)) indices.push(index)
        })
        if (indices.length) {
          cosmographRef.current?.fitViewByIndices?.(indices, 600)
        }
      },
      focusNode: (id: string) => {
        const index = pointIdsRef.current.indexOf(id)
        if (index >= 0) {
          cosmographRef.current?.fitViewByIndices?.([index], 500)
        }
      },
      selectPoints: (ids: string[]) => {
        const idSet = new Set(ids)
        const indices: number[] = []
        pointIdsRef.current.forEach((id, index) => {
          if (idSet.has(id)) indices.push(index)
        })
        cosmographRef.current?.selectPoints?.(indices.length ? indices : [])
      },
      selectNeighbourhood: (id: string) => {
        const index = pointIdsRef.current.indexOf(id)
        if (index < 0) return
        const adj =
          cosmographRef.current?.getConnectedPointIndices?.(index) ?? []
        const indices = [index, ...adj]
        cosmographRef.current?.selectPoints?.(indices)
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
      pointIdsRef.current = []
      return
    }

    hasInitialFitRef.current = false
    pointIdsRef.current = points.map((p) => p.id)
    let cancelled = false
    let fitFallbackTimer: ReturnType<typeof setTimeout> | null = null

    async function load() {
      const hasEdges = links.length > 0

      /* `CosmographDataPrepPointsConfig` tags `pointDefault*` as required even though
       * they're optional at runtime — cast through to sidestep. */
      const prepConfig = {
        points: {
          pointIdBy: "id",
          pointLabelBy: "label",
          pointColorBy: "color",
          pointSizeBy: "size",
        },
        ...(hasEdges
          ? {
              links: {
                linkSourceBy: "source",
                linkTargetsBy: ["target" as const],
                linkColorBy: "color",
              },
            }
          : {}),
      } as CosmographDataPrepConfig

      const result = await prepareCosmographData(
        prepConfig,
        points,
        hasEdges ? links : undefined,
      )

      if (cancelled || !result) return

      const { points: prepPoints, links: prepLinks, cosmographConfig } = result

      /* Cosmograph colours categorical VARCHAR columns via an ordinal palette — it won't
       * take our hex strings as-is. `pointColorByFn` / `linkColorByFn` short-circuit that
       * and return the value straight through. */
      setConfig({
        points: prepPoints,
        links: prepLinks,
        ...cosmographConfig,
        pointColorByFn: (v: unknown) => (typeof v === "string" ? v : "#71717a"),
        pointSizeByFn: (v: unknown) => (typeof v === "number" ? v : 7),
        linkColorByFn: (v: unknown) =>
          typeof v === "string" ? v : "rgba(226,232,240,0.55)",
        pointDefaultColor: "#71717a",
        pointDefaultSize: 7,
        /* Larger hit targets — the [3, 9] range made nodes effectively unclickable
         * in sparse graphs. */
        pointSizeRange: [6, 14],
        linkDefaultColor: "rgba(226,232,240,0.55)",
        linkDefaultWidth: 1.6,
        backgroundColor: "transparent",
        /* No `selectPointOnClick` — the built-in selection greys the entire canvas,
         * which the user doesn't want on a casual click. Search-driven dimming still
         * works because we call `selectPoints()` imperatively from the explorer. */
        focusPointOnClick: true,
        pointGreyoutOpacity: 0.15,
        linkGreyoutOpacity: 0.05,
        disableLogging: import.meta.env.PROD,
        unknownColor: "#52525b",
        /* Tamed layout — the default repulsion/friction combo flung the graph
         * across the viewport whenever data shuffled. Friction range is 0 (high
         * drag) → 1 (none); 0.25 settles decisively. Decay is inverted in the
         * cosmos engine ("smaller = slower cooling") so 8000 cools faster than the
         * 5000 default. */
        simulationRepulsion: 0.4,
        simulationFriction: 0.25,
        simulationLinkSpring: 0.3,
        simulationLinkDistance: 14,
        simulationGravity: 0.35,
        simulationDecay: 8000,
        onSimulationEnd: () => {
          if (!hasInitialFitRef.current) {
            hasInitialFitRef.current = true
            cosmographRef.current?.fitView?.(600)
          }
        },
        onGraphRebuilt: () => {
          /* Fallback in case the simulation settles so fast onSimulationEnd fires before
           * the canvas has taken its final size. 250 ms is enough for layout. */
          if (fitFallbackTimer) clearTimeout(fitFallbackTimer)
          fitFallbackTimer = setTimeout(() => {
            if (!hasInitialFitRef.current) {
              hasInitialFitRef.current = true
              cosmographRef.current?.fitView?.(600)
            }
          }, 250)
        },
        onPointClick: (index: number | undefined) => {
          if (index === undefined) {
            onPointClickRef.current(null)
            return
          }
          const id = pointIdsRef.current[index] ?? null
          onPointClickRef.current(id)
        },
        /* Clicking the label is much easier than hitting the node dot — route it
         * through the same handler. `selectPointOnLabelClick: 'single'` would
         * additionally trigger Cosmograph's own selection (which greys the rest);
         * we skip that since we drive selection imperatively. */
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
    }
  }, [points, links])

  if (!config) {
    return (
      <div
        className="absolute inset-0 h-full min-h-0 w-full min-w-0"
        aria-hidden
      />
    )
  }

  return (
    <Cosmograph
      ref={cosmographRef}
      className="absolute inset-0 h-full min-h-0 w-full min-w-0"
      style={{ touchAction: "none" }}
      {...config}
    />
  )
})
