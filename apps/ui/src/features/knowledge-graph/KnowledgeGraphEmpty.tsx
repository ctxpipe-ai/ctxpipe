export type EmptyReason = "no-projection"

const COPY: Record<EmptyReason, { title: string; body: string }> = {
  "no-projection": {
    title: "No projection yet",
    body: "Graph shows this Workspace’s hydrate units and claims. It appears after the first successful hydrate.",
  },
}

export function KnowledgeGraphEmpty({ reason }: { reason: EmptyReason }) {
  const copy = COPY[reason]
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-1 text-center">
        <h2 className="text-lg font-medium text-foreground">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </div>
    </div>
  )
}
