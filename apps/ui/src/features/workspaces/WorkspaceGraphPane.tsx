import { KnowledgeGraphExplorer } from "@/features/knowledge-graph/KnowledgeGraphExplorer"
import type { WorkspaceGraphPayload } from "./types"

export function WorkspaceGraphPane(props: {
  orgSlug: string
  workspaceSlug: string
  graph: WorkspaceGraphPayload | undefined
  pending: boolean
  error?: Error | null
  onOpenSource?: (path: string) => void
}) {
  const nodeCount = props.graph?.metrics.totalNodes ?? 0
  const noEdges =
    !props.error && nodeCount > 0 && props.graph?.metrics.totalEdges === 0
  return (
    <div className="relative h-full min-h-0 min-w-0 flex-1">
      <KnowledgeGraphExplorer
        key={props.workspaceSlug}
        orgSlug={props.orgSlug}
        graph={props.graph}
        pending={props.pending}
        error={props.error ?? null}
        onOpenSource={props.onOpenSource}
      />
      {noEdges ? (
        <p className="pointer-events-none absolute inset-x-4 top-14 z-10 mx-auto max-w-md rounded-md border border-border bg-zinc-900 px-3 py-2 text-sm text-muted-foreground">
          This graph has {nodeCount.toLocaleString()}{" "}
          {nodeCount === 1 ? "node" : "nodes"} but no edges yet. Edges appear
          when knowledge files link to each other.
        </p>
      ) : null}
    </div>
  )
}
