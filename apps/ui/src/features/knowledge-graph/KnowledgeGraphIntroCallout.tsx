import { IconBook, IconHelp, IconX } from "@tabler/icons-react"
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
      className="pointer-events-auto w-full max-w-sm px-3 py-3 shadow-2xl shadow-black/50"
    >
      <div className="flex items-start justify-between gap-3">
        <PanelLabel className="mb-0 pr-1">Quick tips</PanelLabel>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close tips"
          className="min-h-9 min-w-9 shrink-0 rounded-none border border-transparent text-zinc-500 transition-colors hover:border-zinc-700 hover:bg-zinc-900/80 hover:text-zinc-100"
        >
          <IconX className="mx-auto h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-zinc-500">
        Pan and zoom the canvas, then select a node to open the inspector
        (claims, neighbours, confidence).
      </p>
      <ul className="mt-2.5 list-outside list-disc space-y-1.5 pl-4 text-[13px] leading-snug text-zinc-400 marker:text-zinc-600">
        <li>
          <span className="text-zinc-300">Search</span> — top centre; matches
          names, kinds, and summaries.
        </li>
        <li>
          <span className="text-zinc-300">Node kinds</span> — top right; click
          a kind to hide or show that category.
        </li>
        <li>
          <span className="text-zinc-300">Share a node</span> — the address bar
          adds <span className="font-mono text-zinc-500">?node=…</span> when
          something is selected.
        </li>
      </ul>
      <div className="mt-3 flex flex-col gap-2 border-t border-zinc-800/80 pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <a
          href={KNOWLEDGE_GRAPH_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-none border border-zinc-700/90 bg-zinc-900/80 px-3 py-2 text-left text-[12px] font-medium text-zinc-200 transition-colors hover:border-teal-500/45 hover:text-teal-200"
        >
          <IconBook className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Knowledge graph guide
            <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">
              Opens in a new tab
            </span>
          </span>
        </a>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-9 shrink-0 rounded-none border border-zinc-700/80 px-3 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:border-teal-500/40 hover:bg-teal-950/30 hover:text-teal-100"
        >
          Close
        </button>
      </div>
    </FloatingPanel>
  )
}

export function KnowledgeGraphHelpButton({
  onClick,
}: {
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show knowledge graph tips"
      className="pointer-events-auto inline-flex min-h-9 items-center gap-1.5 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:text-zinc-300"
    >
      <IconHelp className="h-3.5 w-3.5" aria-hidden />
      Tips
    </button>
  )
}
