import { diffLines } from "diff"

export function McpConfigPreviewDiff(props: { before: string; after: string }) {
  const parts = diffLines(props.before, props.after)
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-none border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed">
      <code>
        {parts.map((part, i) => {
          const cls = part.added
            ? "bg-emerald-950/60 text-emerald-100"
            : part.removed
              ? "bg-red-950/50 text-red-200"
              : "text-zinc-300"
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered diff hunks, list is stable
            <span key={i} className={cls}>
              {part.value}
            </span>
          )
        })}
      </code>
    </pre>
  )
}
