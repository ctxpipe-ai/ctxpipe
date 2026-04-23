import { IconExternalLink, IconHelp, IconX } from "@tabler/icons-react"
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
      className="pointer-events-auto w-full max-w-sm px-3 py-3"
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
      <p className="mt-2 text-[12px] leading-snug text-zinc-400">
        Drag the background to <span className="text-zinc-300">pan</span>,
        scroll or pinch to <span className="text-zinc-300">zoom</span>. Click a
        node for the drawer — claims, neighbours, and confidence.
      </p>
      <ul className="mt-2 list-outside list-disc space-y-1 pl-3.5 text-[12px] leading-snug text-zinc-500 marker:text-zinc-600">
        <li>
          <span className="text-zinc-400">
            <span className="text-zinc-300">Narrow</span> — search (top centre)
            and node kinds (top right) filter what stays on the canvas.
          </span>
        </li>
        <li>
          <span className="text-zinc-400">
            <span className="text-zinc-300">Share</span> — the URL gains{" "}
            <span className="font-mono text-zinc-500">?node=…</span> for the
            selected node.
          </span>
        </li>
      </ul>
      <div className="mt-3 flex flex-col gap-2 border-t border-zinc-800/80 pt-3 sm:flex-row sm:items-stretch">
        <a
          href={KNOWLEDGE_GRAPH_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex flex-1 items-center gap-2 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-3 py-2 text-[12px] font-medium text-zinc-200 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:text-zinc-50"
        >
          <IconExternalLink
            className="h-3.5 w-3.5 shrink-0 text-zinc-500"
            aria-hidden
          />
          <span className="min-w-0 leading-snug">
            Full guide
            <span className="mt-0.5 block font-normal text-[11px] text-zinc-500">
              docs.ctxpipe.ai
            </span>
          </span>
        </a>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-auto min-h-8 shrink-0 items-center justify-center rounded-none border border-zinc-800/95 bg-zinc-950/90 px-3 py-2 text-[12px] font-medium uppercase tracking-[0.12em] text-zinc-400 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 sm:w-[5.5rem]"
        >
          Close
        </button>
      </div>
    </FloatingPanel>
  )
}

export function KnowledgeGraphHelpButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show knowledge graph tips"
      className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-300"
    >
      <IconHelp className="h-3.5 w-3.5" aria-hidden />
      Tips
    </button>
  )
}
