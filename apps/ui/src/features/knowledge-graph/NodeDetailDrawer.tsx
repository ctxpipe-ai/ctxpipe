import { IconCopy, IconX } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { PanelLabel } from "./FloatingPanel"
import { KIND_FALLBACK_COLOR } from "./theme"
import type { KnowledgeGraphNode, NodeFacts } from "./types"

function formatIso(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms))
}

export function NodeDetailDrawer({
  node,
  facts,
  kindColor,
  kindColors,
  open,
  onClose,
  onFocus,
}: {
  node: KnowledgeGraphNode
  facts: NodeFacts
  kindColor: string
  kindColors: Map<string, string>
  open: boolean
  onClose: () => void
  onFocus: () => void
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

  const copyId = () => {
    void navigator.clipboard.writeText(node.id).catch(() => {})
  }

  return (
    <aside
      className={cn(
        "absolute right-0 top-0 z-20 flex h-[100dvh] w-[340px] flex-col border-l border-zinc-800/95 bg-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-md transition-transform duration-200 ease-out motion-reduce:transition-none",
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
            {kind}
          </p>
          <h2 className="mt-0.5 truncate font-mono text-sm text-zinc-100">
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
        <DetailRow label="Id">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-zinc-300">
              {node.id}
            </span>
            <button
              type="button"
              onClick={copyId}
              aria-label="Copy id"
              className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
            >
              <IconCopy className="h-3 w-3" aria-hidden />
            </button>
          </div>
        </DetailRow>

        {node.summary?.trim() ? (
          <DetailRow label="Summary">
            <p className="whitespace-pre-wrap text-[12px] leading-snug text-zinc-300">
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
          </DetailRow>
        ) : null}

        {facts.claimIds.size > 0 ? (
          <DetailRow label="Claims">
            <p className="font-mono text-xs tabular-nums text-zinc-300">
              {facts.claimIds.size.toLocaleString()} distinct claim
              {facts.claimIds.size === 1 ? "" : "s"}
            </p>
          </DetailRow>
        ) : null}

        {predicates.length > 0 ? (
          <DetailRow label="Predicates">
            <div className="flex flex-wrap gap-1.5">
              {predicates.map(([pred, count]) => (
                <span
                  key={pred}
                  className="inline-flex items-center gap-1.5 border border-zinc-800/95 bg-zinc-900/70 px-1.5 py-0.5 text-[11px] text-zinc-300"
                >
                  <span>{pred}</span>
                  <span className="font-mono tabular-nums text-zinc-500">
                    {count}
                  </span>
                </span>
              ))}
            </div>
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
                    className="flex items-center gap-2 text-[11px] text-zinc-300"
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
          className="flex-1 px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-teal-400 transition-colors hover:bg-teal-500/10"
        >
          Focus
        </button>
        <div className="w-px bg-zinc-800/95" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
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
      <span className="text-[9px] uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </span>
      <span
        className={cn(
          "tabular-nums text-zinc-100",
          text ? "text-[11px]" : "font-mono text-sm font-semibold",
        )}
      >
        {value}
      </span>
    </div>
  )
}
