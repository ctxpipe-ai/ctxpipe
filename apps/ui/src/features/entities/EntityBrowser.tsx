import { useState, useMemo } from "react"
import { IconSearch, IconTrash, IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import { Modal } from "@/components/ui/Modal"
import { AlertDialog } from "@/components/ui/AlertDialog"
import {
  STUB_NODES,
  STUB_LINKS,
  ENTITY_COLORS,
  type EntityType,
  type GraphNode,
} from "@/features/graph/stub-data"
import { toast } from "sonner"

const TYPE_ORDER: EntityType[] = [
  "Repository",
  "File",
  "Class",
  "Function",
  "Concept",
]

function getRelationships(nodeId: string) {
  const outgoing = STUB_LINKS.filter((l) => l.source === nodeId)
  const incoming = STUB_LINKS.filter((l) => l.target === nodeId)
  return { outgoing, incoming }
}

function nodeById(id: string): GraphNode | undefined {
  return STUB_NODES.find((n) => n.id === id)
}

export function EntityBrowser() {
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

  const handleDelete = (node: GraphNode) => {
    setDeletedIds((prev) => new Set([...prev, node.id]))
    setNodeToDelete(null)
    if (expandedId === node.id) setExpandedId(null)
    toast.success(`Entity "${node.name}" deleted`)
  }

  const typeCounts = useMemo(() => {
    const counts: Partial<Record<EntityType | "All", number>> = { All: filtered.length }
    for (const node of filtered) {
      counts[node.type] = (counts[node.type] ?? 0) + 1
    }
    return counts
  }, [filtered])

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Entities</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Browse and manage knowledge graph nodes for this organisation
          </p>
        </div>

        {/* Search */}
        <div className="relative w-full sm:w-64">
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
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
              )}
              {type}
              <span className="tabular-nums opacity-60">({count})</span>
            </button>
          )
        })}
      </div>

      {/* Entity list */}
      {filtered.length === 0 ? (
        <p className="mt-12 text-center text-sm text-zinc-500">
          No entities match your search.
        </p>
      ) : (
        <div className="divide-y divide-white/6 rounded-xl border border-white/8 bg-zinc-900/50">
          {filtered.map((node) => {
            const isExpanded = expandedId === node.id
            const { outgoing, incoming } = getRelationships(node.id)
            const relCount = outgoing.length + incoming.length

            return (
              <div key={node.id}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                  {/* Expand toggle */}
                  <button
                    onClick={() =>
                      setExpandedId(isExpanded ? null : node.id)
                    }
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
                    <p className="truncate font-mono text-sm text-zinc-100">
                      {node.name}
                    </p>
                    {node.description && (
                      <p className="truncate text-xs text-zinc-500">
                        {node.description}
                      </p>
                    )}
                  </div>

                  {/* Type badge */}
                  <TypeBadge type={node.type} />

                  {/* Relationship count */}
                  <span className="shrink-0 text-xs tabular-nums text-zinc-500">
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

                {/* Relationship panel */}
                {isExpanded && (
                  <div className="border-t border-white/6 bg-zinc-950/50 px-4 py-3">
                    <RelationshipPanel
                      outgoing={outgoing}
                      incoming={incoming}
                    />
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
            Delete <span className="font-mono font-medium">"{nodeToDelete.name}"</span>?
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

function RelationshipPanel({
  outgoing,
  incoming,
}: {
  outgoing: ReturnType<typeof getRelationships>["outgoing"]
  incoming: ReturnType<typeof getRelationships>["incoming"]
}) {
  if (outgoing.length === 0 && incoming.length === 0) {
    return (
      <p className="text-xs text-zinc-600">No relationships.</p>
    )
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
      {outgoing.length > 0 && (
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Outgoing
          </p>
          <ul className="space-y-1">
            {outgoing.map((link, i) => {
              const target = nodeById(link.target)
              return (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <RelBadge type={link.type} />
                  {target && (
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: ENTITY_COLORS[target.type] }}
                    />
                  )}
                  <span className="truncate font-mono text-zinc-300">
                    {target?.name ?? link.target}
                  </span>
                  {target && (
                    <span className="shrink-0 text-zinc-600">
                      ({target.type})
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {incoming.length > 0 && (
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Incoming
          </p>
          <ul className="space-y-1">
            {incoming.map((link, i) => {
              const source = nodeById(link.source)
              return (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <RelBadge type={link.type} />
                  {source && (
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: ENTITY_COLORS[source.type] }}
                    />
                  )}
                  <span className="truncate font-mono text-zinc-300">
                    {source?.name ?? link.source}
                  </span>
                  {source && (
                    <span className="shrink-0 text-zinc-600">
                      ({source.type})
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function RelBadge({ type }: { type: "related_to" | "mentions" }) {
  return (
    <span
      className={[
        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-medium",
        type === "related_to"
          ? "bg-teal-500/15 text-teal-400"
          : "bg-blue-500/15 text-blue-400",
      ].join(" ")}
    >
      {type}
    </span>
  )
}
