import { useState } from "react"
import { graphEdgesForNode, graphNodeById } from "./graph-view"
import type { WorkspaceGraphPayload } from "./types"

export function WorkspaceGraphPane(props: {
  graph: WorkspaceGraphPayload | undefined
  pending: boolean
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  if (props.pending) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="h-3 w-24 rounded-lg bg-zinc-800" />
        <div className="h-8 rounded-lg bg-zinc-900" />
        <div className="h-8 rounded-lg bg-zinc-900" />
      </div>
    )
  }
  const graph = props.graph
  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h2 className="text-lg font-medium text-foreground">
            No projection yet
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Graph shows this Workspace’s hydrate units and claims. It appears
            after the first successful hydrate.
          </p>
        </div>
      </div>
    )
  }
  const selected = graphNodeById(graph, selectedId)
  const edges = graphEdgesForNode(graph, selectedId)
  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-56 shrink-0 overflow-auto border-r border-border p-3">
        <p className="ctx-label mb-2 text-muted-foreground">Units</p>
        <p className="mb-3 font-mono text-xs tabular-nums text-muted-foreground">
          {graph.metrics.totalNodes} units · {graph.metrics.totalEdges} claims
        </p>
        <ul className="space-y-0.5">
          {graph.nodes.map((node) => {
            const active = node.id === selectedId
            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(node.id)}
                  className={[
                    "block w-full truncate rounded-lg px-2 py-1 text-left text-xs",
                    active
                      ? "bg-zinc-800 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  {node.name ?? node.id}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {selected ? (
          <article>
            <p className="ctx-label text-muted-foreground">Unit</p>
            <h2 className="mt-1 text-lg font-medium">{selected.name}</h2>
            {selected.summary ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {selected.summary}
              </p>
            ) : null}
            <p className="ctx-label mt-6 text-muted-foreground">Claims</p>
            {edges.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                This unit has no claims in the current projection.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {edges.map((edge) => (
                  <li
                    key={`${edge.direction}:${edge.predicate}:${edge.neighbourId}`}
                    className="rounded-lg bg-zinc-900 px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-xs text-teal-300">
                      {edge.predicate}
                    </span>
                    <span className="mx-2 text-muted-foreground">
                      {edge.direction === "out" ? "to" : "from"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedId(edge.neighbourId)}
                      className="text-foreground hover:underline"
                    >
                      {edge.neighbourName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a unit to see its claims in this Workspace’s projection.
          </p>
        )}
      </div>
    </div>
  )
}
