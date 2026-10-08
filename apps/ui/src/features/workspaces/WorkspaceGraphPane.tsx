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
  const noRelationships =
    props.graph !== undefined &&
    nodeCount > 0 &&
    props.graph.metrics.totalEdges === 0 &&
    props.graph.edges.length === 0
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
      {noRelationships ? (
        <output className="absolute inset-x-4 block bottom-4 z-30 mx-auto max-w-md rounded-md border border-zinc-800 bg-zinc-950/90 px-3 py-2 text-sm text-muted-foreground">
          This graph has {nodeCount} items but no relationships yet. Links
          between items appear when knowledge files reference each other.
        </output>
      ) : null}
    </div>
  )
}
