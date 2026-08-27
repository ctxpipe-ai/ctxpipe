import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconX,
} from "@tabler/icons-react"
import { type ReactNode, useMemo, useState } from "react"
import { Button } from "@/components/ui/Button"
import { cn } from "@/lib/utils"
import { type ActivityBuckets, ActivitySparkline } from "./ActivitySparkline"
import { KIND_FALLBACK_COLOR } from "./theme"
import type { KnowledgeGraphNode, NodeClaim, NodeFacts } from "./types"

const OVERLAY_PANEL_CLASS =
  "absolute top-2 right-2 bottom-2 z-20 flex w-[min(28rem,calc(100%-1rem))] flex-col rounded-md border border-border bg-zinc-900 shadow-md transition-transform duration-200 ease-out motion-reduce:transition-none"

/** 0.03 → "3%". Rounds to nearest whole percent, floors at 1% so the chip
 * still reads meaningfully for nodes at the very top. */
function formatPercentile(p: number): string {
  // Top-percentile: 0.97 means the node is AT the 97th percentile → top 3%.
  const topFraction = Math.max(0.01, 1 - p)
  return `${Math.round(topFraction * 100)}%`
}

function formatShortDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  }).format(new Date(ms))
}

/** Workspace hydrate units use repo-relative paths as node ids. */
function isWorkspaceFilePath(id: string): boolean {
  return id.includes("/") && !id.includes("://") && !id.startsWith("/")
}

/** 0–1 confidence → label (shown verbatim) + colour token. */
function confidenceTone(c: number | null): { label: string; cls: string } {
  if (c == null) return { label: "—", cls: "text-muted-foreground" }
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
  onOpenSource,
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
  onOpenSource?: (path: string) => void
}) {
  return (
    <aside
      className={cn(
        OVERLAY_PANEL_CLASS,
        open
          ? "pointer-events-auto translate-x-0"
          : "pointer-events-none translate-x-full",
      )}
      aria-label={`Details for ${node.name ?? node.id}`}
      aria-hidden={!open}
    >
      <NodeDetailDrawerBody
        key={node.id}
        node={node}
        facts={facts}
        kindColor={kindColor}
        kindColors={kindColors}
        nodeById={nodeById}
        peerDegrees={peerDegrees}
        onClose={onClose}
        onFocus={onFocus}
        onNeighbourSelect={onNeighbourSelect}
        onOpenSource={onOpenSource}
      />
    </aside>
  )
}

function NodeDetailDrawerBody({
  node,
  facts,
  kindColor,
  kindColors,
  nodeById,
  peerDegrees,
  onClose,
  onFocus,
  onNeighbourSelect,
  onOpenSource,
}: {
  node: KnowledgeGraphNode
  facts: NodeFacts
  kindColor: string
  kindColors: Map<string, string>
  nodeById: Map<string, KnowledgeGraphNode>
  peerDegrees: number[]
  onClose: () => void
  onFocus: () => void
  onNeighbourSelect: (id: string) => void
  onOpenSource?: (path: string) => void
}) {
  const kind = node.kind || "Unknown"
  const title = node.name?.trim() || node.id
  const predicates = Array.from(facts.predicateCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  const neighbourKinds = Array.from(facts.neighbourKindCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  )
  const totalDegree = facts.inDegree + facts.outDegree

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
  const [copied, setCopied] = useState(false)

  const filteredClaims = useMemo(
    () =>
      predicateFilter
        ? facts.claims.filter((c) => c.predicate === predicateFilter)
        : facts.claims,
    [facts.claims, predicateFilter],
  )

  const copyId = () => {
    void navigator.clipboard
      .writeText(node.id)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1800)
      })
      .catch(() => {})
  }

  const canOpenSource = onOpenSource != null && isWorkspaceFilePath(node.id)

  return (
    <>
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <Button
            variant="ghost"
            onPress={onFocus}
            aria-label={`Focus ${title} on the graph`}
            className="-ml-1 h-auto max-w-full justify-start px-1 py-0 text-left"
          >
            <span className="block truncate text-lg font-medium leading-tight text-foreground">
              {title}
            </span>
          </Button>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Tag>
              <span
                className="size-1.5 shrink-0 rounded-sm"
                style={{ backgroundColor: kindColor }}
                aria-hidden
              />
              {kind}
            </Tag>
            {peerRank ? (
              <Tag
                title={`Rank ${peerRank.rankFromTop.toLocaleString()} of ${peerRank.totalPeers.toLocaleString()} ${kind} nodes by total connections`}
              >
                Top {formatPercentile(peerRank.percentile)}
              </Tag>
            ) : null}
            {isIsolated ? (
              <Tag
                className="border-amber-500/40 bg-amber-950 text-amber-200"
                title="Few or no connections — may indicate a stub or stale entity"
              >
                <IconAlertTriangle
                  className="size-3.5 text-amber-400"
                  aria-hidden
                />
                Loosely connected
              </Tag>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onPress={onClose}
          aria-label="Close details"
        >
          <IconX className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        <Section label="Path">
          <div className="flex h-5 items-center gap-1">
            <p
              className="min-w-0 flex-1 truncate font-mono text-sm leading-5 text-foreground"
              title={node.id}
            >
              {node.id}
            </p>
            <Button
              variant="quiet"
              onPress={copyId}
              aria-label={copied ? "Path copied" : "Copy path"}
              className="size-5 min-h-5 min-w-5 p-0"
            >
              {copied ? (
                <IconCheck className="size-3.5 text-teal-400" aria-hidden />
              ) : (
                <IconCopy className="size-3.5" aria-hidden />
              )}
            </Button>
            {canOpenSource ? (
              <Button
                variant="quiet"
                onPress={() => onOpenSource(node.id)}
                aria-label="Go to definition"
                className="size-5 min-h-5 min-w-5 p-0"
              >
                <IconArrowUpRight className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
        </Section>

        {kindChips.length > 0 ? (
          <Section label={`${kind} details`}>
            <ul className="flex flex-col gap-1.5">
              {kindChips.map(([k, v]) => (
                <li
                  key={k}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="text-xs text-muted-foreground">{k}</span>
                  <span className="truncate text-sm text-foreground">{v}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {node.summary?.trim() ? (
          <Section label="Summary">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {node.summary}
            </p>
          </Section>
        ) : null}

        <Section label="Connections">
          <div
            role="img"
            className="flex items-center gap-2"
            aria-label={`${facts.inDegree.toLocaleString()} in, ${facts.outDegree.toLocaleString()} out`}
          >
            <p className="text-sm tabular-nums text-foreground">
              {facts.inDegree.toLocaleString()}{" "}
              <span className="text-muted-foreground">in</span>
            </p>
            <IconArrowRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span
              className="size-4 shrink-0 rounded-sm"
              style={{ backgroundColor: kindColor }}
              aria-hidden
            />
            <IconArrowRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <p className="text-sm tabular-nums text-foreground">
              {facts.outDegree.toLocaleString()}{" "}
              <span className="text-muted-foreground">out</span>
            </p>
          </div>
        </Section>

        {nodeActivity ? (
          <Section label="Activity">
            <ActivitySparkline buckets={nodeActivity} />
          </Section>
        ) : null}

        {strongestConnections.length > 0 ? (
          <Section label="Strongest connections">
            <ul className="-mx-2 flex flex-col">
              {strongestConnections.map(([nid, count]) => {
                const nb = nodeById.get(nid)
                const k = nb?.kind || "Unknown"
                const color = kindColors.get(k) ?? KIND_FALLBACK_COLOR
                const name = nb?.name?.trim() || nid
                return (
                  <li key={nid}>
                    <Button
                      variant="ghost"
                      onPress={() => onNeighbourSelect(nid)}
                      className="h-auto w-full justify-start gap-2 px-2 py-1.5"
                    >
                      <span
                        className="inline-block size-2 shrink-0 rounded-sm"
                        style={{ backgroundColor: color }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
                        {name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {k}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        ×{count}
                      </span>
                    </Button>
                  </li>
                )
              })}
            </ul>
          </Section>
        ) : null}

        {predicates.length > 0 ? (
          <Section label="Predicates">
            <div className="-mx-2 flex flex-wrap items-center gap-1.5">
              {predicates.map(([pred, count]) => {
                const active = predicateFilter === pred
                return (
                  <Button
                    key={pred}
                    variant={active ? "secondary" : "ghost"}
                    onPress={() => setPredicateFilter(active ? null : pred)}
                    aria-pressed={active}
                    className="h-7 px-2"
                  >
                    <span>{pred}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </Button>
                )
              })}
              {predicateFilter ? (
                <Button
                  variant="quiet"
                  onPress={() => setPredicateFilter(null)}
                  className="h-7 px-2"
                >
                  Clear filter
                </Button>
              ) : null}
            </div>
          </Section>
        ) : null}

        {facts.claims.length > 0 ? (
          <Section
            label={
              predicateFilter
                ? `Claims · ${filteredClaims.length.toLocaleString()} / ${facts.claims.length.toLocaleString()}`
                : `Claims · ${facts.claims.length.toLocaleString()}`
            }
          >
            <ClaimList
              claims={filteredClaims}
              nodeById={nodeById}
              kindColors={kindColors}
              onNeighbourSelect={onNeighbourSelect}
            />
          </Section>
        ) : null}

        {neighbourKinds.length > 0 ? (
          <Section label="Neighbour kinds">
            <ul className="flex flex-col gap-1.5">
              {neighbourKinds.map(([k, c]) => {
                const color = kindColors.get(k) ?? KIND_FALLBACK_COLOR
                return (
                  <li
                    key={k}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <span
                      className="inline-block size-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{k}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {c}
                    </span>
                  </li>
                )
              })}
            </ul>
          </Section>
        ) : null}
      </div>
    </>
  )
}

function Tag({
  children,
  className,
  title,
}: {
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-zinc-800 px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium leading-none text-muted-foreground">
        {label}
      </h3>
      {children}
    </section>
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
    const ta = a.observedAt ?? Number.NEGATIVE_INFINITY
    const tb = b.observedAt ?? Number.NEGATIVE_INFINITY
    return tb - ta
  })

  return (
    <ul className="-mx-2 flex max-h-64 flex-col gap-2 overflow-y-auto">
      {sorted.map((c, i) => {
        const neighbour = nodeById.get(c.neighbourId)
        const neighbourKind = neighbour?.kind || "Unknown"
        const neighbourName = neighbour?.name?.trim() || c.neighbourId
        const kindColor = kindColors.get(neighbourKind) ?? KIND_FALLBACK_COLOR
        const tone = confidenceTone(c.confidence)
        const when =
          c.observedAt != null ? formatShortDate(c.observedAt) : "unknown"
        const key = `${c.direction}-${c.predicate}-${c.neighbourId}-${i}`
        return (
          <li key={key}>
            <Button
              variant="ghost"
              onPress={() => onNeighbourSelect(c.neighbourId)}
              className="h-auto w-full flex-col items-stretch gap-0.5 rounded-md px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <IconArrowRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground",
                    c.direction === "in" && "-scale-x-100",
                  )}
                  aria-hidden
                />
                <span className="text-xs text-muted-foreground">
                  {c.predicate}
                </span>
                <Tag className="shrink-0">
                  <span
                    className="size-1.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: kindColor }}
                    aria-hidden
                  />
                  {neighbourKind}
                </Tag>
                <span className="ml-auto shrink-0 text-xs">
                  <span className="text-muted-foreground">confidence: </span>
                  <span className={cn("tabular-nums", tone.cls)}>
                    {tone.label}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 truncate text-sm text-foreground">
                  {neighbourName}
                </span>
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  {when}
                </span>
              </div>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
