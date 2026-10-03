import { IconFocusCentered, IconSearch, IconX } from "@tabler/icons-react"
import { type ReactNode, useMemo, useState } from "react"
import { Button } from "@/components/ui/Button"
import { cn } from "@/lib/utils"
import { PanelLabel } from "./FloatingPanel"
import { KIND_FALLBACK_COLOR } from "./theme"
import type { KnowledgeGraphNode } from "./types"

export type SelectionInspectorModel = {
  source: "lasso" | "timeline"
  title: string
  description: string
  nodeIds: string[]
  nodes: KnowledgeGraphNode[]
  edgeCount: number
  kindCounts: Array<[string, number]>
  predicateCounts: Array<[string, number]>
  range?: { from: number; to: number }
}

function displayNodeName(node: KnowledgeGraphNode): string {
  return node.name?.trim() || node.id
}

function formatRange(range: { from: number; to: number }): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
  return `${formatter.format(new Date(range.from))} - ${formatter.format(
    new Date(range.to),
  )}`
}

export function SelectionInspectorPanel({
  kindColors,
  onClose,
  onFitSelection,
  onNodeSelect,
  selection,
}: {
  kindColors: Map<string, string>
  onClose: () => void
  onFitSelection: () => void
  onNodeSelect: (id: string) => void
  selection: SelectionInspectorModel
}) {
  const [query, setQuery] = useState("")
  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return selection.nodes
    return selection.nodes.filter((node) =>
      [node.id, node.name ?? "", node.kind, node.summary ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    )
  }, [query, selection.nodes])
  const shownNodes = filteredNodes.slice(0, 80)
  const hiddenNodeCount = Math.max(0, filteredNodes.length - shownNodes.length)

  return (
    <aside
      className="pointer-events-auto absolute top-2 right-2 bottom-2 z-20 flex w-[min(28rem,calc(100%-1rem))] translate-x-0 flex-col rounded-md border border-border bg-zinc-900 shadow-md transition-transform duration-200 ease-out motion-reduce:transition-none"
      aria-label={selection.title}
    >
      <div className="flex items-start gap-3 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          <p className="ctx-label text-muted-foreground">
            {selection.source === "lasso" ? "Lasso selection" : "Time filter"}
          </p>
          <h2 className="mt-0.5 truncate text-lg font-medium text-foreground">
            {selection.title}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onPress={onClose}
          aria-label="Close selection inspector"
        >
          <IconX className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <p className="text-sm leading-snug text-zinc-400">
          {selection.description}
        </p>

        {selection.range ? (
          <DetailBlock label="Range">
            <p className="font-mono text-xs text-zinc-300">
              {formatRange(selection.range)}
            </p>
          </DetailBlock>
        ) : null}

        <DetailBlock label="Summary">
          <div className="grid grid-cols-2 gap-0 border border-zinc-800/95">
            <StatCell label="Nodes" value={selection.nodeIds.length} accent />
            <StatCell label="Edges" value={selection.edgeCount} />
          </div>
        </DetailBlock>

        <div>
          <Button
            variant="outline"
            onPress={onFitSelection}
            isDisabled={selection.nodeIds.length === 0}
          >
            <IconFocusCentered
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            Fit selection
          </Button>
        </div>

        {selection.kindCounts.length > 0 ? (
          <DetailBlock label="Node kinds">
            <div className="flex flex-wrap gap-1.5">
              {selection.kindCounts.slice(0, 10).map(([kind, count]) => (
                <span
                  key={kind}
                  className="inline-flex items-center gap-1.5 border border-zinc-800/95 bg-zinc-900/70 px-1.5 py-0.5 text-sm text-zinc-300"
                >
                  <span
                    className="h-2 w-2"
                    style={{
                      backgroundColor:
                        kindColors.get(kind) ?? KIND_FALLBACK_COLOR,
                    }}
                    aria-hidden
                  />
                  <span>{kind}</span>
                  <span className="font-mono tabular-nums text-zinc-500">
                    {count.toLocaleString()}
                  </span>
                </span>
              ))}
            </div>
          </DetailBlock>
        ) : null}

        {selection.predicateCounts.length > 0 ? (
          <DetailBlock label="Predicates">
            <div className="flex flex-wrap gap-1.5">
              {selection.predicateCounts
                .slice(0, 12)
                .map(([predicate, count]) => (
                  <span
                    key={predicate}
                    className="inline-flex items-center gap-1.5 border border-zinc-800/95 bg-zinc-900/70 px-1.5 py-0.5 text-sm text-zinc-300"
                  >
                    <span className="truncate">{predicate}</span>
                    <span className="font-mono tabular-nums text-zinc-500">
                      {count.toLocaleString()}
                    </span>
                  </span>
                ))}
            </div>
          </DetailBlock>
        ) : null}

        <DetailBlock label={`Nodes · ${filteredNodes.length.toLocaleString()}`}>
          <div className="relative mb-2">
            <IconSearch
              className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter selected nodes"
              className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul className="flex flex-col gap-0.5">
            {shownNodes.map((node) => {
              const kind = node.kind || "Unknown"
              const color = kindColors.get(kind) ?? KIND_FALLBACK_COLOR
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onNodeSelect(node.id)}
                    className="flex w-full items-center gap-2 border border-transparent bg-zinc-900/40 px-2 py-1 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900/80"
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-200">
                        {displayNodeName(node)}
                      </span>
                      <span className="block truncate font-mono text-xs text-zinc-600">
                        {node.id}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs uppercase tracking-[0.12em] text-zinc-500">
                      {kind}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {hiddenNodeCount > 0 ? (
            <p className="mt-2 text-xs text-zinc-600">
              {hiddenNodeCount.toLocaleString()} more matching nodes hidden.
              Narrow the filter to inspect them.
            </p>
          ) : null}
        </DetailBlock>
      </div>
    </aside>
  )
}

function DetailBlock({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <section>
      <PanelLabel className="mb-1.5">{label}</PanelLabel>
      {children}
    </section>
  )
}

function StatCell({
  accent = false,
  label,
  value,
}: {
  accent?: boolean
  label: string
  value: number
}) {
  return (
    <div
      className={cn(
        "border-zinc-800/95 px-2 py-1.5 first:border-r",
        accent ? "bg-teal-500/5" : "bg-zinc-900/45",
      )}
    >
      <div className="font-mono text-xs uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate font-mono text-sm tabular-nums",
          accent ? "text-teal-200" : "text-zinc-300",
        )}
      >
        {value.toLocaleString()}
      </div>
    </div>
  )
}
