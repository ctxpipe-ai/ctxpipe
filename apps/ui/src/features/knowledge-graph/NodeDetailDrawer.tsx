import { IconArrowRight, IconCopy, IconX } from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { type ActivityBuckets, ActivitySparkline } from "./ActivitySparkline"
import { PanelLabel } from "./FloatingPanel"
import { KIND_FALLBACK_COLOR } from "./theme"
import type { KnowledgeGraphNode, NodeClaim, NodeFacts } from "./types"

/** 0.03 → "3%". Rounds to nearest whole percent, floors at 1% so the chip
 * still reads meaningfully for nodes at the very top. */
function formatPercentile(p: number): string {
  // Top-percentile: 0.97 means the node is AT the 97th percentile → top 3%.
  const topFraction = Math.max(0.01, 1 - p)
  return `${Math.round(topFraction * 100)}%`
}

function formatIso(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms))
}

function formatShortDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  }).format(new Date(ms))
}

/** 0–1 confidence → label (shown verbatim) + tailwind colour token. */
function confidenceTone(c: number | null): { label: string; cls: string } {
  if (c == null) return { label: "—", cls: "text-zinc-500" }
  const pct = Math.round(c * 100)
  if (c >= 0.85) return { label: `${pct}%`, cls: "text-teal-300" }
  if (c >= 0.65) return { label: `${pct}%`, cls: "text-amber-300" }
  return { label: `${pct}%`, cls: "text-rose-300" }
}

/** `peerDegrees` is the sorted (asc) degree list for this node's kind.
 * Returns null for sole-of-kind nodes where "Top 1% of 1" would be nonsense. */
function computePeerRank(
  degree: number,
  peerDegrees: number[],
): { percentile: number; rankFromTop: number; totalPeers: number } | null {
  if (peerDegrees.length < 2) return null
  // count peers strictly less than this node's degree (ties don't boost rank)
  let lo = 0
  let hi = peerDegrees.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((peerDegrees[mid] ?? 0) < degree) lo = mid + 1
    else hi = mid
  }
  const below = lo
  // percentile = fraction of peers at or below this node's degree
  const percentile = (below + 1) / peerDegrees.length
  const rankFromTop = peerDegrees.length - below
  return { percentile, rankFromTop, totalPeers: peerDegrees.length }
}

/** Bucket claim observedAt timestamps into a weekly histogram for the
 * per-node activity sparkline. Mirrors the global `activityBuckets` math in
 * the explorer so the widget looks/behaves identically. */
function buildNodeActivityBuckets(claims: NodeClaim[]): ActivityBuckets | null {
  const stamps: number[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const c of claims) {
    if (c.observedAt == null) continue
    stamps.push(c.observedAt)
    if (c.observedAt < min) min = c.observedAt
    if (c.observedAt > max) max = c.observedAt
  }
  if (stamps.length === 0) return null
  const WEEK = 7 * 24 * 60 * 60 * 1000
  const span = Math.max(max - min, WEEK)
  const bucketCount = Math.min(16, Math.max(4, Math.ceil(span / WEEK)))
  const bucketSize = span / bucketCount
  const counts = new Array<number>(bucketCount).fill(0)
  for (const t of stamps) {
    const idx = Math.min(bucketCount - 1, Math.floor((t - min) / bucketSize))
    counts[idx] = (counts[idx] ?? 0) + 1
  }
  return { counts, rangeStart: min, rangeEnd: max, total: stamps.length }
}

/** Known node-payload fields worth showing as "kind-aware" chips. Anything
 * else in the payload is ignored to avoid leaking internals. */
const KIND_CHIP_FIELDS: Record<string, ReadonlyArray<string>> = {
  Service: ["owner_team", "tier", "language", "package"],
  App: ["platform", "package"],
  Library: ["language", "package"],
  Database: ["engine", "cluster"],
  API: ["protocol", "version"],
  Stream: ["platform", "schema_name"],
  Infrastructure: ["infra_kind", "platform"],
  Pattern: ["category"],
  InstructionUnit: ["intent", "modality", "path"],
  Skill: ["intent_summary"],
}

function extractKindChips(node: KnowledgeGraphNode): Array<[string, string]> {
  const chips: Array<[string, string]> = []
  const keys = KIND_CHIP_FIELDS[node.kind]
  if (!keys) return chips
  // The payload fields aren't surfaced on the current `/knowledge-graph`
  // endpoint — only `id`, `kind`, `name`, `summary`. This is here so it
  // Just Works the moment a future backend change ships richer payload.
  const raw = (node as unknown as Record<string, unknown>).payload
  const bag =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  for (const k of keys) {
    const v = bag?.[k]
    if (typeof v === "string" && v.length > 0) chips.push([k, v])
    else if (typeof v === "number") chips.push([k, String(v)])
  }
  return chips
}

export function NodeDetailDrawer({
  node,
  facts,
  kindColor,
  kindColors,
  nodeById,
  peerDegrees,
  open,
  onClose,
  onFocus,
  onNeighbourSelect,
  onAskAgent,
}: {
  node: KnowledgeGraphNode
  facts: NodeFacts
  kindColor: string
  kindColors: Map<string, string>
  nodeById: Map<string, KnowledgeGraphNode>
  peerDegrees: number[]
  open: boolean
  onClose: () => void
  onFocus: () => void
  onNeighbourSelect: (id: string) => void
  onAskAgent: (seed: string) => void
}) {
  const kind = node.kind || "Unknown"
  const predicates = Array.from(facts.predicateCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  const neighbourKinds = Array.from(facts.neighbourKindCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  )
  const totalDegree = facts.inDegree + facts.outDegree
  const firstSeen = facts.firstObserved ? formatIso(facts.firstObserved) : "—"
  const lastSeen = facts.lastObserved ? formatIso(facts.lastObserved) : "—"

  const peerRank = useMemo(
    () => computePeerRank(totalDegree, peerDegrees),
    [totalDegree, peerDegrees],
  )
  const isIsolated = totalDegree <= 2

  /** Top 5 neighbours by claim count. Clicking pivots selection to that node. */
  const strongestConnections = useMemo(() => {
    const byNeighbour = new Map<string, number>()
    for (const c of facts.claims) {
      byNeighbour.set(c.neighbourId, (byNeighbour.get(c.neighbourId) ?? 0) + 1)
    }
    return Array.from(byNeighbour.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  }, [facts.claims])

  const nodeActivity = useMemo(
    () => buildNodeActivityBuckets(facts.claims),
    [facts.claims],
  )

  const kindChips = useMemo(() => extractKindChips(node), [node])

  const [predicateFilter, setPredicateFilter] = useState<string | null>(null)
  // Reset the predicate filter when the selected node changes. biome's
  // useExhaustiveDependencies flags `node.id` as unused because the effect
  // body doesn't read it, but the dep IS the trigger — that's the point.
  // biome-ignore lint/correctness/useExhaustiveDependencies: node.id is the reset trigger
  useEffect(() => {
    setPredicateFilter(null)
  }, [node.id])

  const filteredClaims = useMemo(
    () =>
      predicateFilter
        ? facts.claims.filter((c) => c.predicate === predicateFilter)
        : facts.claims,
    [facts.claims, predicateFilter],
  )

  const [copied, setCopied] = useState<"id" | "link" | null>(null)
  // Reset the "copied" flash when the selected node changes; stale feedback
  // on a different node would be misleading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: node.id is the reset trigger
  useEffect(() => {
    setCopied(null)
  }, [node.id])

  const flashCopied = (kind: "id" | "link") => {
    setCopied(kind)
    window.setTimeout(() => {
      // Only clear if this particular flash is still the current one — avoids
      // a later copy's timer stomping on an earlier one mid-flash.
      setCopied((prev) => (prev === kind ? null : prev))
    }, 1800)
  }

  const copyId = () => {
    void navigator.clipboard
      .writeText(node.id)
      .then(() => flashCopied("id"))
      .catch(() => {})
  }

  const copyDeepLink = () => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    url.searchParams.set("node", node.id)
    void navigator.clipboard
      .writeText(url.toString())
      .then(() => flashCopied("link"))
      .catch(() => {})
  }

  /** Compact, user-visible prompt the Chat UI autosends. Kept plain-text so
   * the user can read/edit it if they land on the chat before it fires. */
  const buildAskSeed = (): string => {
    const lines: string[] = []
    const label = node.name?.trim() || node.id
    lines.push(`I want to understand this ${kind}: ${label} (${node.id}).`)
    lines.push("")
    lines.push(
      `Connections: ${facts.inDegree} in · ${facts.outDegree} out · ${totalDegree} total.`,
    )
    if (strongestConnections.length > 0) {
      const links = strongestConnections
        .slice(0, 5)
        .map(([nid]) => {
          const nb = nodeById.get(nid)
          return `${nb?.name?.trim() || nid} (${nb?.kind || "Unknown"})`
        })
        .join(", ")
      lines.push(`Strongest links: ${links}.`)
    }
    if (predicates.length > 0) {
      const preds = predicates
        .slice(0, 5)
        .map(([p, c]) => `${p} (${c})`)
        .join(", ")
      lines.push(`Common predicates: ${preds}.`)
    }
    if (node.summary?.trim()) {
      lines.push(`Summary: ${node.summary.trim()}`)
    }
    lines.push("")
    lines.push(
      "Please explain what this node does, how it fits in the broader system based on its connections, and any risk areas worth paying attention to.",
    )
    return lines.join("\n")
  }

  return (
    <aside
      className={cn(
        "absolute right-0 top-0 z-20 flex h-[100dvh] w-[440px] max-w-[90vw] flex-col border-l border-zinc-800/95 bg-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-md transition-transform duration-200 ease-out motion-reduce:transition-none",
        open
          ? "pointer-events-auto translate-x-0"
          : "pointer-events-none translate-x-full",
      )}
      aria-label={`Details for ${node.name ?? node.id}`}
      aria-hidden={!open}
    >
      <div className="flex items-start gap-3 border-b border-zinc-800/95 p-4">
        <span
          className="mt-0.5 inline-block h-3 w-3 shrink-0"
          style={{ backgroundColor: kindColor }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
            {kind}
          </p>
          <h2 className="mt-0.5 truncate font-mono text-[13px] text-zinc-100">
            {node.name?.trim() || node.id}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-zinc-500 transition-colors hover:text-zinc-100"
        >
          <IconX className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
            {peerRank ? (
              <span
                className="inline-flex max-w-full items-center gap-1.5 border border-teal-500/30 bg-teal-500/5 px-2 py-0.5 text-[12px] text-teal-200"
                title={`Rank ${peerRank.rankFromTop.toLocaleString()} of ${peerRank.totalPeers.toLocaleString()} ${kind} nodes by total connections`}
              >
                <span className="font-mono uppercase tracking-[0.12em] text-teal-400/80">
                  Rank
                </span>
                <span className="truncate tabular-nums">
                  Top {formatPercentile(peerRank.percentile)} of {kind}
                </span>
              </span>
            ) : null}
            {isIsolated ? (
              <span
                className="inline-flex max-w-full items-center gap-1.5 border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[12px] text-amber-200"
                title="Few or no connections — may indicate a stub or stale entity"
              >
                <span className="font-mono uppercase tracking-[0.12em] text-amber-400/80">
                  ⚠
                </span>
                <span className="truncate">Loosely connected</span>
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onAskAgent(buildAskSeed())}
            className="inline-flex shrink-0 items-center gap-1.5 border border-teal-500/55 bg-teal-500/10 px-2 py-0.5 text-[12px] text-teal-200 transition-colors hover:border-teal-500/70 hover:bg-teal-500/15"
            title="Ask the graph chat about this node"
          >
            Ask ctx|
          </button>
        </div>

        <DetailRow label="Id">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[13px] text-zinc-300">
              {node.id}
            </span>
            <button
              type="button"
              onClick={copyId}
              aria-label={copied === "id" ? "Id copied" : "Copy id"}
              className={cn(
                "shrink-0 transition-colors",
                copied === "id"
                  ? "text-teal-300"
                  : "text-zinc-500 hover:text-zinc-200",
              )}
              title={copied === "id" ? "Copied!" : "Copy id"}
            >
              <IconCopy className="h-3 w-3" aria-hidden />
            </button>
            <button
              type="button"
              onClick={copyDeepLink}
              aria-live="polite"
              className={cn(
                "ml-auto shrink-0 border px-2 py-0.5 text-[12px] transition-colors",
                copied === "link"
                  ? "border-teal-500/55 bg-teal-500/10 text-teal-200"
                  : "border-zinc-800/95 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
              )}
              title="Copy a shareable link that opens the graph with this node already selected"
            >
              {copied === "link" ? "Copied!" : "Copy link"}
            </button>
          </div>
        </DetailRow>

        {kindChips.length > 0 ? (
          <DetailRow label={`${kind} details`}>
            <div className="flex flex-wrap gap-1.5">
              {kindChips.map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1.5 border border-zinc-800/95 bg-zinc-900/70 px-1.5 py-0.5 text-[13px] text-zinc-300"
                >
                  <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-zinc-500">
                    {k}
                  </span>
                  <span className="truncate">{v}</span>
                </span>
              ))}
            </div>
          </DetailRow>
        ) : null}

        {node.summary?.trim() ? (
          <DetailRow label="Summary">
            <p className="whitespace-pre-wrap text-[13px] leading-snug text-zinc-300">
              {node.summary}
            </p>
          </DetailRow>
        ) : null}

        <DetailRow label="Connections">
          <div className="grid grid-cols-3 gap-0 border border-zinc-800/95">
            <StatCell label="In" value={facts.inDegree} />
            <StatCell label="Out" value={facts.outDegree} />
            <StatCell label="Total" value={totalDegree} accent />
          </div>
        </DetailRow>

        {facts.firstObserved || facts.lastObserved ? (
          <DetailRow label="Activity">
            <div className="grid grid-cols-2 gap-0 border border-zinc-800/95">
              <StatCell label="First seen" value={firstSeen} text />
              <StatCell label="Last seen" value={lastSeen} text accent />
            </div>
            {nodeActivity ? (
              <div className="mt-2 [&>div]:w-full">
                <ActivitySparkline buckets={nodeActivity} />
              </div>
            ) : null}
          </DetailRow>
        ) : null}

        {strongestConnections.length > 0 ? (
          <DetailRow label="Strongest connections">
            <ul className="flex flex-col gap-0.5">
              {strongestConnections.map(([nid, count]) => {
                const nb = nodeById.get(nid)
                const k = nb?.kind || "Unknown"
                const color = kindColors.get(k) ?? KIND_FALLBACK_COLOR
                const name = nb?.name?.trim() || nid
                return (
                  <li key={nid}>
                    <button
                      type="button"
                      onClick={() => onNeighbourSelect(nid)}
                      className="flex w-full items-center gap-2 border border-transparent bg-zinc-900/40 px-2 py-1 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900/80"
                    >
                      <span
                        className="inline-block h-2 w-2 shrink-0"
                        style={{ backgroundColor: color }}
                        aria-hidden
                      />
                      <span className="flex-1 truncate text-[13px] text-zinc-200">
                        {name}
                      </span>
                      <span className="shrink-0 text-[12px] uppercase tracking-[0.12em] text-zinc-500">
                        {k}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-[12px] text-teal-300">
                        ×{count}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </DetailRow>
        ) : null}

        {predicates.length > 0 ? (
          <DetailRow label="Predicates · click to filter claims">
            <div className="flex flex-wrap gap-1.5">
              {predicates.map(([pred, count]) => {
                const active = predicateFilter === pred
                return (
                  <button
                    key={pred}
                    type="button"
                    onClick={() => setPredicateFilter(active ? null : pred)}
                    className={cn(
                      "inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[13px] transition-colors",
                      active
                        ? "border-teal-500/55 bg-teal-500/10 text-teal-200"
                        : "border-zinc-800/95 bg-zinc-900/70 text-zinc-300 hover:border-zinc-700",
                    )}
                    aria-pressed={active}
                  >
                    <span>{pred}</span>
                    <span className="font-mono tabular-nums text-zinc-500">
                      {count}
                    </span>
                  </button>
                )
              })}
              {predicateFilter ? (
                <button
                  type="button"
                  onClick={() => setPredicateFilter(null)}
                  className="text-[12px] text-teal-400 hover:text-teal-300"
                >
                  Clear filter
                </button>
              ) : null}
            </div>
          </DetailRow>
        ) : null}

        {facts.claims.length > 0 ? (
          <DetailRow
            label={
              predicateFilter
                ? `Claims · ${filteredClaims.length.toLocaleString()} / ${facts.claims.length.toLocaleString()} (${predicateFilter})`
                : `Claims · ${facts.claims.length.toLocaleString()}`
            }
          >
            <ClaimList
              claims={filteredClaims}
              nodeById={nodeById}
              kindColors={kindColors}
              onNeighbourSelect={onNeighbourSelect}
            />
          </DetailRow>
        ) : null}

        {neighbourKinds.length > 0 ? (
          <DetailRow label="Neighbour kinds">
            <ul className="flex flex-col gap-0.5">
              {neighbourKinds.map(([k, c]) => {
                const color = kindColors.get(k) ?? KIND_FALLBACK_COLOR
                return (
                  <li
                    key={k}
                    className="flex items-center gap-2 text-[13px] text-zinc-300"
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{k}</span>
                    <span className="font-mono tabular-nums text-zinc-500">
                      {c}
                    </span>
                  </li>
                )
              })}
            </ul>
          </DetailRow>
        ) : null}
      </div>

      <div className="flex gap-0 border-t border-zinc-800/95 bg-zinc-950/90">
        <button
          type="button"
          onClick={onFocus}
          className="flex-1 px-3 py-2.5 text-[13px] font-medium uppercase tracking-[0.14em] text-teal-400 transition-colors hover:bg-teal-500/10"
        >
          Focus
        </button>
        <div className="w-px bg-zinc-800/95" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-3 py-2.5 text-[13px] font-medium uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          Close
        </button>
      </div>
    </aside>
  )
}

function DetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <PanelLabel>{label}</PanelLabel>
      {children}
    </div>
  )
}

function StatCell({
  label,
  value,
  text = false,
  accent = false,
}: {
  label: string
  value: number | string
  text?: boolean
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 px-2.5 py-1.5",
        accent && "bg-teal-500/5",
      )}
    >
      <span className="text-[12px] uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </span>
      <span
        className={cn(
          "tabular-nums text-zinc-100",
          text ? "text-[13px]" : "font-mono text-[13px] font-semibold",
        )}
      >
        {value}
      </span>
    </div>
  )
}

function ClaimList({
  claims,
  nodeById,
  kindColors,
  onNeighbourSelect,
}: {
  claims: NodeClaim[]
  nodeById: Map<string, KnowledgeGraphNode>
  kindColors: Map<string, string>
  onNeighbourSelect: (id: string) => void
}) {
  // Most recent first; unknown timestamps sink to the bottom.
  const sorted = [...claims].sort((a, b) => {
    const ta = a.observedAt ?? -Infinity
    const tb = b.observedAt ?? -Infinity
    return tb - ta
  })

  return (
    <ul className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto border border-zinc-800/95 bg-zinc-950/60 p-1.5">
      {sorted.map((c, i) => {
        const neighbour = nodeById.get(c.neighbourId)
        const neighbourKind = neighbour?.kind || "Unknown"
        const neighbourName = neighbour?.name?.trim() || c.neighbourId
        const kindColor = kindColors.get(neighbourKind) ?? KIND_FALLBACK_COLOR
        const tone = confidenceTone(c.confidence)
        const when =
          c.observedAt != null ? formatShortDate(c.observedAt) : "unknown"
        const arrow =
          c.direction === "out" ? (
            <IconArrowRight
              className="h-3 w-3 shrink-0 text-zinc-500"
              aria-hidden
            />
          ) : (
            <IconArrowRight
              className="h-3 w-3 shrink-0 -scale-x-100 text-zinc-500"
              aria-hidden
            />
          )
        const key = `${c.direction}-${c.predicate}-${c.neighbourId}-${i}`
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onNeighbourSelect(c.neighbourId)}
              className="flex w-full flex-col gap-1 border border-transparent bg-zinc-900/40 px-2 py-1.5 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900/80"
            >
              <div className="flex items-center gap-1.5">
                {arrow}
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-400">
                  {c.predicate}
                </span>
                <span
                  className={cn(
                    "ml-auto shrink-0 font-mono text-[12px] tabular-nums",
                    tone.cls,
                  )}
                  title={`Aggregated confidence ${tone.label}`}
                >
                  {tone.label}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0"
                  style={{ backgroundColor: kindColor }}
                  aria-hidden
                />
                <span className="truncate text-[13px] text-zinc-200">
                  {neighbourName}
                </span>
                <span className="ml-auto shrink-0 text-[12px] uppercase tracking-[0.14em] text-zinc-500">
                  {neighbourKind}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[12px] tabular-nums text-zinc-500">
                <span>{when}</span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
