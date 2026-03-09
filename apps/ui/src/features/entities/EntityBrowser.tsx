import { useState, useMemo, useRef, useEffect } from "react"
import { useWindowVirtualizer } from "@tanstack/react-virtual"
import { IconSearch, IconTrash, IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import { Modal } from "@/components/ui/Modal"
import { AlertDialog } from "@/components/ui/AlertDialog"
import {
  STUB_NODES,
  STUB_LINKS,
  ENTITY_COLORS,
  type EntityType,
  type GraphNode,
  type GraphLink,
} from "@/features/graph/stub-data"
import { toast } from "sonner"

const TYPE_ORDER: EntityType[] = ["Repository", "File", "Class", "Function", "Concept"]

// Pre-compute O(1) lookup maps at module level — never recomputed
const NODE_MAP = new Map<string, GraphNode>(STUB_NODES.map((n) => [n.id, n]))

const OUTGOING_MAP = new Map<string, GraphLink[]>()
const INCOMING_MAP = new Map<string, GraphLink[]>()
for (const link of STUB_LINKS) {
  if (!OUTGOING_MAP.has(link.source)) OUTGOING_MAP.set(link.source, [])
  OUTGOING_MAP.get(link.source)!.push(link)
  if (!INCOMING_MAP.has(link.target)) INCOMING_MAP.set(link.target, [])
  INCOMING_MAP.get(link.target)!.push(link)
}

// Pre-compute per-node relationship counts
const REL_COUNT_MAP = new Map<string, number>(
  STUB_NODES.map((n) => [
    n.id,
    (OUTGOING_MAP.get(n.id)?.length ?? 0) + (INCOMING_MAP.get(n.id)?.length ?? 0),
  ]),
)

export function EntityBrowser() {
  const listRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<EntityType | "All">("All")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [nodeToDelete, setNodeToDelete] = useState<GraphNode | null>(null)
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return STUB_NODES.filter((n) => {
      if (deletedIds.has(n.id)) return false
      if (typeFilter !== "All" && n.type !== typeFilter) return false
      if (q && !n.name.toLowerCase().includes(q) && !n.description?.toLowerCase().includes(q))
        return false
      return true
    }).sort(
      (a, b) =>
        TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
        a.name.localeCompare(b.name),
    )
  }, [search, typeFilter, deletedIds])

  const typeCounts = useMemo(() => {
    const counts: Partial<Record<EntityType | "All", number>> = { All: filtered.length }
    for (const node of filtered) counts[node.type] = (counts[node.type] ?? 0) + 1
    return counts
  }, [filtered])

  const virtualizer = useWindowVirtualizer({
    count: filtered.length,
    estimateSize: () => 56,
    overscan: 10,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    measureElement:
      typeof window !== "undefined" ? (el) => el.getBoundingClientRect().height : undefined,
  })

  // Keep a stable ref to measure() so the effect below doesn't need the
  // virtualizer object itself as a dependency (it changes identity each render).
  const measureRef = useRef(virtualizer.measure.bind(virtualizer))
  measureRef.current = virtualizer.measure.bind(virtualizer)

  // Re-measure when the expanded row changes height
  useEffect(() => {
    measureRef.current()
  }, [expandedId])

  const handleDelete = (node: GraphNode) => {
    setDeletedIds((prev) => new Set([...prev, node.id]))
    setNodeToDelete(null)
    if (expandedId === node.id) setExpandedId(null)
    toast.success(`Entity "${node.name}" deleted`)
  }

  const items = virtualizer.getVirtualItems()

  return (
    <div className="px-6 py-8">
      {/* Header + search */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Entities</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Browse and manage knowledge graph nodes for this organisation
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <IconSearch
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search entities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-lg border border-white/10 bg-zinc-900 pl-9 pr-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-teal-500/60 focus:ring-1 focus:ring-teal-500/30"
          />
        </div>
      </div>

      {/* Type filter pills */}
      <div className="mb-4 flex flex-wrap gap-2">
        {(["All", ...TYPE_ORDER] as const).map((type) => {
          const count = typeCounts[type] ?? 0
          const isActive = typeFilter === type
          const color = type !== "All" ? ENTITY_COLORS[type] : undefined
          return (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={[
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "border-transparent bg-teal-500/20 text-teal-300"
                  : "border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-200",
              ].join(" ")}
            >
              {color && (
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              )}
              {type}
              <span className="tabular-nums opacity-60">({count})</span>
            </button>
          )
        })}
      </div>

      {/* Entity list */}
      {filtered.length === 0 ? (
        <p className="mt-12 text-center text-sm text-zinc-500">No entities match your search.</p>
      ) : (
        <div
          className="rounded-xl border border-white/8 bg-zinc-900/50"
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          ref={listRef}
        >
          {items.map((virtualRow) => {
            const node = filtered[virtualRow.index]
            const isExpanded = expandedId === node.id
            const relCount = REL_COUNT_MAP.get(node.id) ?? 0

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                }}
                className={virtualRow.index > 0 ? "border-t border-white/6" : undefined}
              >
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                  {/* Expand toggle */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : node.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:text-zinc-300"
                    aria-label={isExpanded ? "Collapse" : "Expand relationships"}
                  >
                    {isExpanded ? (
                      <IconChevronDown className="h-4 w-4" />
                    ) : (
                      <IconChevronRight className="h-4 w-4" />
                    )}
                  </button>

                  {/* Type dot */}
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: ENTITY_COLORS[node.type] }}
                  />

                  {/* Name + description */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm text-zinc-100">{node.name}</p>
                    {node.description && (
                      <p className="truncate text-xs text-zinc-500">{node.description}</p>
                    )}
                  </div>

                  {/* Repository */}
                  {node.repository && (
                    <span className="hidden shrink-0 truncate text-xs text-zinc-500 sm:block sm:max-w-[180px]">
                      {node.repository}
                    </span>
                  )}

                  {/* Type badge */}
                  <TypeBadge type={node.type} />

                  {/* Relationship count */}
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-zinc-500">
                    {relCount} rel{relCount !== 1 ? "s" : ""}
                  </span>

                  {/* Delete */}
                  <button
                    onClick={() => setNodeToDelete(node)}
                    aria-label={`Delete ${node.name}`}
                    className="shrink-0 rounded p-1 text-zinc-600 transition-colors hover:bg-red-500/15 hover:text-red-400"
                  >
                    <IconTrash className="h-4 w-4" />
                  </button>
                </div>

                {isExpanded && (
                  <div className="border-t border-white/6 bg-zinc-950/50 px-4 py-3">
                    <RelationshipPanel nodeId={node.id} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Delete confirmation */}
      {nodeToDelete && (
        <Modal
          isOpen={!!nodeToDelete}
          onOpenChange={(open) => !open && setNodeToDelete(null)}
          isDismissable
        >
          <AlertDialog
            title="Delete entity"
            variant="destructive"
            actionLabel="Delete"
            cancelLabel="Cancel"
            onAction={() => handleDelete(nodeToDelete)}
          >
            Delete <span className="font-mono font-medium">"{nodeToDelete.name}"</span>?{" "}
            This will remove the node and all its relationships from the knowledge graph.
          </AlertDialog>
        </Modal>
      )}
    </div>
  )
}

function TypeBadge({ type }: { type: EntityType }) {
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{
        backgroundColor: `${ENTITY_COLORS[type]}18`,
        color: ENTITY_COLORS[type],
        border: `1px solid ${ENTITY_COLORS[type]}33`,
      }}
    >
      {type}
    </span>
  )
}

function RelationshipPanel({ nodeId }: { nodeId: string }) {
  const outgoing = OUTGOING_MAP.get(nodeId) ?? []
  const incoming = INCOMING_MAP.get(nodeId) ?? []

  if (outgoing.length === 0 && incoming.length === 0) {
    return <p className="text-xs text-zinc-600">No relationships.</p>
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
      {outgoing.length > 0 && (
        <RelationshipList title="Outgoing" links={outgoing} idKey="target" />
      )}
      {incoming.length > 0 && (
        <RelationshipList title="Incoming" links={incoming} idKey="source" />
      )}
    </div>
  )
}

function RelationshipList({
  title,
  links,
  idKey,
}: {
  title: string
  links: GraphLink[]
  idKey: "source" | "target"
}) {
  const MAX_SHOWN = 50
  const shown = links.slice(0, MAX_SHOWN)

  return (
    <div className="min-w-0 flex-1">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      <ul className="space-y-1">
        {shown.map((link, i) => {
          const peerId = link[idKey]
          const peer = NODE_MAP.get(peerId)
          return (
            <li key={i} className="flex items-center gap-2 text-xs">
              <RelBadge type={link.type} />
              {peer && (
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: ENTITY_COLORS[peer.type] }}
                />
              )}
              <span className="truncate font-mono text-zinc-300">{peer?.name ?? peerId}</span>
              {peer && <span className="shrink-0 text-zinc-600">({peer.type})</span>}
            </li>
          )
        })}
      </ul>
      {links.length > MAX_SHOWN && (
        <p className="mt-1 text-xs text-zinc-600">
          +{(links.length - MAX_SHOWN).toLocaleString()} more
        </p>
      )}
    </div>
  )
}

function RelBadge({ type }: { type: "related_to" | "mentions" }) {
  return (
    <span
      className={[
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-medium",
        type === "related_to" ? "bg-teal-500/15 text-teal-400" : "bg-blue-500/15 text-blue-400",
      ].join(" ")}
    >
      {type}
    </span>
  )
}
