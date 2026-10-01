import {
  Cosmograph,
  type CosmographConfig,
  type CosmographDataPrepConfig,
  CosmographProvider,
  type CosmographRef,
  prepareCosmographData,
} from "@cosmograph/react"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  KIND_FALLBACK_COLOR,
  KIND_PALETTE,
  LINK_BASE,
  UNKNOWN_COLOR,
} from "@/features/knowledge-graph/theme"
import type { KnowledgeGraphPayload } from "@/features/knowledge-graph/types"
import { client } from "@/lib/api"

/**
 * The org's real knowledge graph, small and read-only, while it is built.
 * Merges the real graph (projected at the end of each repository's run) with
 * the provisional one recorded as extractors finish, so it grows from the
 * first minutes. Same query key as the explorer for the real graph, so that
 * cache carries over after setup. Re-fetches while `live`; new entities join
 * without resetting the layout.
 */
export function OnboardingGraphPreview({
  orgSlug,
  live,
}: {
  orgSlug: string
  live: boolean
}) {
  const { data } = useQuery({
    queryKey: ["knowledge-graph", orgSlug],
    queryFn: async (): Promise<KnowledgeGraphPayload> => {
      const res = await client[":orgSlug"].api.v1["knowledge-graph"].$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Could not load the knowledge graph.")
      return res.json()
    },
    refetchInterval: live ? 8000 : false,
  })
  // What the extractors have found so far, before it reaches the real graph
  // at the end of each repository's run. Empty once nothing is indexing.
  const { data: provisional } = useQuery({
    queryKey: ["knowledge-graph-preview", orgSlug],
    queryFn: async () => {
      const res = await fetch(`/${orgSlug}/api/v1/knowledge-graph/preview`, {
        credentials: "include",
      })
      if (!res.ok) throw new Error("Could not load the graph preview.")
      return (await res.json()) as {
        nodes: Array<{ id: string; kind: string; name: string | null }>
        edges: Array<{ sourceId: string; targetId: string; predicate: string }>
      }
    },
    refetchInterval: live ? 5000 : false,
  })

  // Same rows as the explorer: label, kind for colour, degree for size. The
  // real graph and the provisional one are merged; their ids never collide
  // (object ids against extractors' keys).
  const { points, links } = useMemo(() => {
    const nodes = [
      ...(data?.nodes ?? []),
      ...(provisional?.nodes ?? []).map((node) => ({ ...node, summary: null })),
    ].filter((node) => node.id)
    const ids = new Set(nodes.map((node) => String(node.id)))
    const degree = new Map<string, number>()
    const links = [
      ...(data?.edges ?? []),
      ...(provisional?.edges ?? []).map((edge) => ({
        ...edge,
        confidence: null,
        lastObservedAt: null,
      })),
    ]
      .filter(
        (edge) =>
          ids.has(String(edge.sourceId)) && ids.has(String(edge.targetId)),
      )
      .map((edge) => {
        const source = String(edge.sourceId)
        const target = String(edge.targetId)
        degree.set(source, (degree.get(source) ?? 0) + 1)
        degree.set(target, (degree.get(target) ?? 0) + 1)
        return {
          source,
          target,
          predicate: edge.predicate || "Unknown",
          confidence: edge.confidence,
        }
      })
    const points = nodes.map((node) => ({
      id: String(node.id),
      label: node.name?.trim() || String(node.id).slice(0, 8),
      kind: node.kind || "Unknown",
      degree: degree.get(String(node.id)) ?? 0,
    }))
    return { points, links }
  }, [data, provisional])

  const cosmographRef = useRef<CosmographRef>(undefined)
  const [config, setConfig] = useState<CosmographConfig | null>(null)
  // Cosmograph prepares its columns asynchronously, outside React.
  useEffect(() => {
    if (points.length === 0) {
      setConfig(null)
      return
    }
    let cancelled = false
    const hasLinks = links.length > 0
    void prepareCosmographData(
      {
        points: {
          pointIdBy: "id",
          pointLabelBy: "label",
          pointColorBy: "kind",
          pointColorPalette: [...KIND_PALETTE],
          pointSizeBy: "degree",
        },
        ...(hasLinks
          ? {
              links: {
                linkSourceBy: "source",
                linkTargetsBy: ["target" as const],
                linkWidthBy: "confidence",
              },
            }
          : {}),
      } as CosmographDataPrepConfig,
      points,
      hasLinks ? links : undefined,
    )
      .then((result) => {
        if (cancelled || !result) return
        setConfig({
          points: result.points,
          links: result.links,
          ...result.cosmographConfig,
          // Calm settle, like the explorer, at preview scale.
          simulationDecay: 2400,
          simulationGravity: 0.46,
          simulationRepulsion: 1.32,
          simulationLinkSpring: 0.08,
          simulationLinkDistance: 2,
          simulationFriction: 0.85,

          pointDefaultColor: KIND_FALLBACK_COLOR,
          pointSizeRange: [2, 7],
          linkDefaultColor: LINK_BASE,
          linkDefaultWidth: 0.5,
          linkWidthRange: [0.3, 1.6],
          unknownColor: UNKNOWN_COLOR,
          backgroundColor: "rgba(0, 0, 0, 0)",
          showLabels: false,
          showClusterLabels: false,
          enableDrag: false,
          enableZoom: false,
          fitViewOnInit: true,
          fitViewDelay: 2500,
          fitViewPadding: 0.15,
          // Frame the graph once the layout has spread out, and again as
          // new entities arrive and it settles.
          onSimulationEnd: () => cosmographRef.current?.fitView?.(600, 0.15),
          preservePointPositionsOnDataUpdate: true,
          disableLogging: import.meta.env.PROD,
        })
      })
      .catch(() => {
        if (!cancelled) setConfig(null)
      })
    return () => {
      cancelled = true
    }
  }, [points, links])

  return (
    <>
      {config ? (
        <CosmographProvider>
          <Cosmograph
            ref={cosmographRef}
            className="absolute inset-x-0 top-12 bottom-0"
            style={{ backgroundColor: "transparent" }}
            {...config}
          />
        </CosmographProvider>
      ) : (
        <span className="absolute inset-x-0 bottom-0 flex flex-col gap-2">
          <span className="onb-line-loader" />
          <span className="font-mono text-xs text-zinc-500">
            building your graph
          </span>
        </span>
      )}
      <span className="absolute inset-x-0 top-0 flex flex-col items-start gap-1 font-mono text-xs">
        <span className="border border-teal-400/30 bg-zinc-950/80 px-1.5 uppercase tracking-wider text-teal-400">
          Preview
        </span>
        {points.length > 0 ? (
          <span className="whitespace-nowrap text-zinc-400">
            <GrowingCount value={points.length} /> entities ·{" "}
            <GrowingCount value={links.length} /> links
          </span>
        ) : null}
      </span>
    </>
  )
}

/**
 * Counts up to a new value and pulses once when it grows, so the graph's
 * growth reads at a glance. Reduced motion shows the new value straight away.
 */
function GrowingCount({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const [pulse, setPulse] = useState(0)
  const shownRef = useRef(value)
  // Animating a number over time is outside React's render; this Effect
  // drives it with requestAnimationFrame and cancels on change.
  useEffect(() => {
    const from = shownRef.current
    if (
      value <= from ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      shownRef.current = value
      setShown(value)
      return
    }
    setPulse((count) => count + 1)
    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 900)
      const next = Math.round(from + (value - from) * (1 - (1 - t) ** 3))
      shownRef.current = next
      setShown(next)
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value])
  return (
    <span
      key={pulse}
      className={`tabular-nums ${pulse > 0 ? "onb-count-pulse" : "text-zinc-200"}`}
    >
      {shown}
    </span>
  )
}
