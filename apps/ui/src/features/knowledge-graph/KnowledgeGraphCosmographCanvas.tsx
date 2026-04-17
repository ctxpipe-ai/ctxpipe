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
import { KIND_FALLBACK_COLOR, LINK_BASE, PAGE_BG, UNKNOWN_COLOR } from "./theme"

export type KnowledgeGraphCosmographCanvasHandle = {
  fitView: () => void
  fitToIds: (ids: string[]) => void
  focusNode: (id: string) => void
  selectPoints: (ids: string[]) => void
  /** Node + its 1-hop neighbours; others dim. */
  selectNeighbourhood: (id: string) => void
  unselectAll: () => void
}

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
  /** `null` when the click missed a point. */
  onPointClick: (id: string | null) => void
  onBackgroundClick: () => void
}

const REVEAL_AFTER_FIT_MS = 80
const SETTLE_FALLBACK_MS = 1600

/** Hides the early simulation scramble behind an overlay and reveals only the
 * settled, fitted layout. */
export const KnowledgeGraphCosmographCanvas = forwardRef<
  KnowledgeGraphCosmographCanvasHandle,
  KnowledgeGraphCosmographCanvasProps
>(function KnowledgeGraphCosmographCanvas(
  { points, links, onPointClick, onBackgroundClick },
  ref,
) {
  const cosmographRef = useRef<CosmographRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig | null>(null)
  const [isSettled, setIsSettled] = useState(false)
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
      pointIdsRef.current = []
      return
    }

    hasInitialFitRef.current = false
    setIsSettled(false)
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

      const scheduleReveal = () => {
        if (revealTimer) clearTimeout(revealTimer)
        revealTimer = setTimeout(() => setIsSettled(true), REVEAL_AFTER_FIT_MS)
      }

      /* Cosmograph colours categorical VARCHAR columns via an ordinal palette;
       * the Fn variants pass our hex strings straight through instead. */
      setConfig({
        points: prepPoints,
        links: prepLinks,
        ...cosmographConfig,
        pointColorByFn: (v: unknown) =>
          typeof v === "string" ? v : KIND_FALLBACK_COLOR,
        pointSizeByFn: (v: unknown) => (typeof v === "number" ? v : 7),
        linkColorByFn: (v: unknown) => (typeof v === "string" ? v : LINK_BASE),
        pointDefaultColor: KIND_FALLBACK_COLOR,
        pointDefaultSize: 7,
        pointSizeRange: [6, 14],
        linkDefaultColor: LINK_BASE,
        linkDefaultWidth: 1.6,
        backgroundColor: "transparent",
        focusPointOnClick: true,
        pointGreyoutOpacity: 0.15,
        linkGreyoutOpacity: 0.05,
        disableLogging: import.meta.env.PROD,
        unknownColor: UNKNOWN_COLOR,
        spaceSize: 900,
        simulationRepulsion: 0.2,
        simulationFriction: 0.7,
        simulationLinkSpring: 0.25,
        simulationLinkDistance: 10,
        simulationGravity: 0.8,
        simulationCenter: 0.3,
        simulationDecay: 700,
        simulationImpulse: 0,
        fitViewOnInit: false,
        fitViewPadding: 0.15,
        onSimulationEnd: () => {
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
            setIsSettled(true)
          }, SETTLE_FALLBACK_MS)
        },
        onPointClick: (index: number | undefined) => {
          if (index === undefined) {
            onPointClickRef.current(null)
            return
          }
          onPointClickRef.current(pointIdsRef.current[index] ?? null)
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
    <>
      <div
        className="absolute inset-0 h-full min-h-0 w-full min-w-0 transition-opacity duration-300 ease-out motion-reduce:transition-none"
        style={{ opacity: isSettled ? 1 : 0 }}
      >
        <Cosmograph
          ref={cosmographRef}
          className="absolute inset-0 h-full min-h-0 w-full min-w-0"
          style={{ touchAction: "none" }}
          {...config}
        />
      </div>
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300 ease-out motion-reduce:transition-none"
        style={{
          backgroundColor: PAGE_BG,
          opacity: isSettled ? 0 : 1,
        }}
        aria-hidden
      >
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-zinc-600">
          <span className="inline-block h-1.5 w-1.5 animate-pulse bg-teal-400" />
          <span>Laying out graph…</span>
        </div>
      </div>
    </>
  )
})
