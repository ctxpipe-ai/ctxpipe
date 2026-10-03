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
    </div>
  )
}
