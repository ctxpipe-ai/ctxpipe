import { cn } from "@/lib/utils"

/**
 * A process wait: a teal label and a sliding bar for work that has no known
 * end, such as a fetch that the user started. Use `Skeleton` for a region whose
 * content loads (a list, a pane): it keeps the box of the loaded content.
 *
 * It centers itself in its parent (`mx-auto w-fit`), so a caller seldom needs a
 * wrapper.
 */
export function InlineLoader({
  label,
  sublabel,
  className,
}: {
  /** Uppercase caption next to the pulse dot (e.g. "Loading repositories"). */
  label: string
  /** Optional lighter-weight line underneath (e.g. "3 repos · 2 agents"). */
  sublabel?: string
  className?: string
}) {
  return (
    <output
      className={cn(
        "mx-auto flex w-fit flex-col items-center gap-2 py-2 text-center",
        className,
      )}
    >
      <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
        <span
          aria-hidden
          className="inline-block h-2 w-2 animate-pulse bg-teal-400"
        />
        <span>{label}</span>
      </div>
      <div
        aria-hidden
        className="relative h-1 w-56 overflow-hidden bg-zinc-900/80"
      >
        <span className="inline-loader-indeterminate absolute inset-y-0 w-1/3 bg-teal-400" />
      </div>
      {sublabel ? (
        <p className="text-[12px] tabular-nums text-zinc-500">{sublabel}</p>
      ) : null}
    </output>
  )
}
