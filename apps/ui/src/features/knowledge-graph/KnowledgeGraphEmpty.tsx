import { IconAffiliate } from "@tabler/icons-react"

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
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <span className="ctx-node text-muted-foreground" aria-hidden>
          <IconAffiliate className="size-4" aria-hidden />
        </span>
        <div className="space-y-1">
          <h2 className="text-lg font-medium text-foreground">{copy.title}</h2>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
        </div>
      </div>
    </div>
  )
}
