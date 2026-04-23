import { IconBook, IconHelp, IconX } from "@tabler/icons-react"
import { FloatingPanel, PanelLabel } from "./FloatingPanel"

const DOCS_KG_URL = "https://docs.ctxpipe.ai/docs"

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
      className="pointer-events-auto max-w-sm px-3 py-3"
    >
      <div className="flex items-start justify-between gap-2">
        <PanelLabel className="mb-1.5">Getting started</PanelLabel>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss tips"
          className="-m-1 shrink-0 p-1 text-zinc-500 transition-colors hover:text-zinc-200"
        >
          <IconX className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ul className="list-inside list-disc space-y-1.5 text-[13px] leading-snug text-zinc-400">
        <li>
          <span className="text-zinc-300">Explore</span> — pan and zoom the
          canvas; select a node to inspect claims and neighbours in the drawer.
        </li>
        <li>
          <span className="text-zinc-300">Narrow down</span> — search matches
          labels and kinds; use node kinds to hide categories you do not need
          right now.
        </li>
        <li>
          <span className="text-zinc-300">Share</span> — the URL updates with
          your selected node so you can send a link back to the same view.
        </li>
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-3">
        <a
          href={DOCS_KG_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-none border border-zinc-700/90 bg-zinc-900/80 px-2.5 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:border-teal-500/45 hover:text-teal-200"
        >
          <IconBook className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Documentation
        </a>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[12px] text-teal-400/95 hover:text-teal-300"
        >
          Got it
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
      className="pointer-events-auto inline-flex items-center gap-1 rounded-none border border-zinc-800/95 bg-zinc-950/90 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:text-zinc-300"
    >
      <IconHelp className="h-3 w-3" aria-hidden />
      Tips
    </button>
  )
}
