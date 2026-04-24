import { IconExternalLink, IconHelp, IconX } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { FloatingPanel, PanelLabel } from "./FloatingPanel"

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
      className="pointer-events-auto w-[min(24rem,calc(100vw-2rem))] px-3 py-3"
    >
      <div className="flex items-start justify-between gap-2">
        <PanelLabel className="mb-0 pr-1">Using this view</PanelLabel>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close tips"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-none border border-zinc-800/95 bg-zinc-950/90 text-zinc-500 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
        >
          <IconX className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <ul className="mt-2 list-outside list-disc space-y-1.5 pl-3.5 text-[12px] leading-snug text-zinc-400 marker:text-zinc-600">
        <li>
          <span className="font-medium text-teal-400">Explore</span> by
          click-dragging the background to pan and using the mouse wheel or
          trackpad to zoom.
        </li>
        <li>
          <span className="font-medium text-teal-400">Interact</span> with
          nodes to inspect relationships, then ask ctx| to dig further from that
          graph context.
        </li>
        <li>
          <span className="font-medium text-teal-400">Monitor</span> activity
          to see when relationship evidence has changed recently.
        </li>
      </ul>
      <div className="mt-3 border-t border-zinc-800/80 pt-3">
        <a
          href={KNOWLEDGE_GRAPH_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-teal-400 transition-colors hover:text-teal-300"
        >
          Docs
          <IconExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </FloatingPanel>
  )
}

export function KnowledgeGraphHelpButton({
  className,
  onClick,
}: {
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show knowledge graph tips"
      className={cn(
        "pointer-events-auto inline-flex h-8 w-40 items-center gap-1.5 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-300",
        className,
      )}
    >
      <IconHelp className="h-3.5 w-3.5" aria-hidden />
      Tips
    </button>
  )
}
