import { IconExternalLink, IconX } from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"
import { FloatingPanel } from "./FloatingPanel"

/** Product guide: Using the app → Knowledge graph */
export const KNOWLEDGE_GRAPH_DOCS_URL =
  "https://docs.ctxpipe.ai/docs/using-the-app/knowledge-graph"

type KnowledgeGraphIntroCalloutProps = {
  open: boolean
  onDismiss: () => void
}

export function KnowledgeGraphIntroCallout({
  open,
  onDismiss,
}: KnowledgeGraphIntroCalloutProps) {
  if (!open) return null

  return (
    <FloatingPanel
      role="dialog"
      ariaLabel="Knowledge graph tips"
      className="pointer-events-auto w-full max-w-sm px-3 py-3"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="pr-1 text-sm font-medium text-foreground">
          Using this view
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          onPress={onDismiss}
          aria-label="Close tips"
        >
          <IconX className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </div>
      <ul className="mt-2 list-outside list-disc space-y-1.5 pl-3.5 text-sm leading-snug text-muted-foreground marker:text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Explore</span> by
          click-dragging the background to pan and using the mouse wheel or
          trackpad to zoom.
        </li>
        <li>
          <span className="font-medium text-foreground">Inspect</span> a node to
          see its claims and neighbours in this Workspace’s projection.
        </li>
        <li>
          <span className="font-medium text-foreground">Monitor</span> activity
          to see when relationship evidence has changed recently.
        </li>
      </ul>
      <div className="mt-3 border-t border-border pt-3">
        <a
          href={KNOWLEDGE_GRAPH_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-400 hover:text-teal-300"
        >
          Docs
          <IconExternalLink className="size-4" aria-hidden />
        </a>
      </div>
    </FloatingPanel>
  )
}
