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
  /** Zoom so the node and its 1-hop neighbours fit the viewport — contextual
   * framing for deep-link landings, unlike `focusNode` which over-zooms. */
  focusNeighbourhood: (id: string) => void
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
  { points, links, onPointClick, onBackgroundClick },
  ref,
) {
  const cosmographRef = useRef<CosmographRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig | null>(null)
  const [isSettled, setIsSettled] = useState(false)
  const [prepStage, setPrepStage] = useState<
    "idle" | "preparing" | "ready" | "error"
  >("idle")
  const [prepError, setPrepError] = useState<string | null>(null)
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
    setIsSettled(false)
    setPrepStage("preparing")
    setPrepError(null)
    pointIdsRef.current = points.map((p) => p.id)
    let cancelled = false
    let fitFallbackTimer: ReturnType<typeof setTimeout> | null = null
    let revealTimer: ReturnType<typeof setTimeout> | null = null

    async function load() {
      const hasEdges = links.length > 0
      const t0 =
        typeof performance !== "undefined" ? performance.now() : Date.now()
      // biome-ignore lint/suspicious/noConsole: intentional diagnostic for large-graph loads
      console.info(
        `[kg-canvas] preparing ${points.length.toLocaleString()} points / ${links.length.toLocaleString()} links`,
      )

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

      let result: Awaited<ReturnType<typeof prepareCosmographData>>
      try {
        result = await prepareCosmographData(
          prepConfig,
          points,
          hasEdges ? links : undefined,
        )
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: surface prep failure
        console.error("[kg-canvas] prepareCosmographData threw", err)
        if (!cancelled) {
          setPrepStage("error")
          setPrepError(err instanceof Error ? err.message : String(err))
        }
        return
      }

      const elapsed = Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
          t0,
      )
      // biome-ignore lint/suspicious/noConsole: timing
      console.info(
        `[kg-canvas] prepareCosmographData done in ${elapsed}ms, result=${result ? "ok" : "null"}`,
      )

      if (cancelled) return
      if (!result) {
        setPrepStage("error")
        setPrepError(
          "Cosmograph returned no result. Check devtools console for details.",
        )
        return
      }

      const { points: prepPoints, links: prepLinks, cosmographConfig } = result

      const scheduleReveal = () => {
        if (revealTimer) clearTimeout(revealTimer)
        revealTimer = setTimeout(() => setIsSettled(true), REVEAL_AFTER_FIT_MS)
      }

      const n = points.length
      const isLargeGraph = n > 20_000
      /* Conservative known-good sim params for large graphs (this was the
       * "organic blob with visible clusters" layout before the circular-shape
       * tuning attempt). Revisit once rendering is reliable. */
      const spaceSize = Math.max(1200, Math.round(Math.sqrt(n) * 18))

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
        /* Exaggerated range for large graphs: low-degree nodes render sub-pixel
         * at default zoom and visually "disappear", leaving the high-degree
         * landmarks readable — progressive disclosure via zoom. */
        pointSizeRange: isLargeGraph ? [1, 28] : [6, 14],
        linkDefaultColor: LINK_BASE,
        linkDefaultWidth: isLargeGraph ? 0.6 : 1.6,
        backgroundColor: "transparent",
        focusPointOnClick: true,
        pointGreyoutOpacity: 0.15,
        linkGreyoutOpacity: 0.05,
        disableLogging: import.meta.env.PROD,
        unknownColor: UNKNOWN_COLOR,
        spaceSize,
        simulationRepulsion: isLargeGraph ? 0.85 : 0.2,
        simulationFriction: isLargeGraph ? 0.88 : 0.7,
        simulationLinkSpring: isLargeGraph ? 0.6 : 0.25,
        simulationLinkDistance: isLargeGraph ? 14 : 10,
        simulationGravity: isLargeGraph ? 0.05 : 0.8,
        simulationCenter: isLargeGraph ? 0 : 0.3,
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
          }, settleFallbackMs(n))
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
      setPrepStage("ready")
    }

    void load()

    return () => {
      cancelled = true
      if (fitFallbackTimer) clearTimeout(fitFallbackTimer)
      if (revealTimer) clearTimeout(revealTimer)
    }
  }, [points, links])

  if (!config) {
    /* Visible state so the user isn't staring at a black screen if
     * `prepareCosmographData` throws, hangs, or silently returns nothing. */
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
              {links.length.toLocaleString()} edges — large graphs can take
              30–60 s at this stage
            </p>
          </>
        ) : null}
        {prepStage === "error" ? (
          <div className="max-w-md border border-red-500/35 bg-red-950/40 px-4 py-3 text-[13px] text-red-200">
            <p className="font-semibold uppercase tracking-[0.14em] text-red-300">
              Graph prep failed
            </p>
            <p className="mt-2 break-words">{prepError}</p>
            <p className="mt-2 text-[12px] text-red-300/75">
              Check the browser devtools console for `[kg-canvas]` log lines.
            </p>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <div
        className="absolute inset-0 h-full min-h-0 w-full min-w-0 outline-none transition-opacity duration-300 ease-out [&_canvas]:outline-none [&_canvas]:focus:outline-none [&_canvas]:focus-visible:outline-none motion-reduce:transition-none"
        style={{ opacity: isSettled ? 1 : 0 }}
      >
        <Cosmograph
          ref={cosmographRef}
          className="absolute inset-0 h-full min-h-0 w-full min-w-0 outline-none"
          style={{ touchAction: "none", outline: "none" }}
          {...config}
        />
      </div>
      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 transition-opacity duration-300 ease-out motion-reduce:transition-none"
        style={{
          backgroundColor: PAGE_BG,
          opacity: isSettled ? 0 : 1,
        }}
        aria-hidden
      >
        <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.24em] text-teal-400">
          <span className="inline-block h-2 w-2 animate-pulse bg-teal-400" />
          <span>Laying out graph</span>
        </div>
        {points.length > 0 ? (
          <p className="text-[12px] text-zinc-500 tabular-nums">
            {points.length.toLocaleString()} nodes ·{" "}
            {links.length.toLocaleString()} edges
          </p>
        ) : null}
      </div>
    </>
  )
})
