import { cn } from "@/lib/utils"

/**
 * Shared teal indeterminate loader — mirrors the KnowledgeGraph canvas
 * layout overlay so loading states across the product read as the same
 * visual language. Use for fetch-in-progress UI where we have a label but
 * no meaningful ETA.
 */
export function InlineLoader({
  label,
  sublabel,
  className,
}: {
  /** Uppercase caption next to the pulse dot (e.g. "Loading repositories"). */
  label: string
  /** Optional lighter-weight line underneath (e.g. "4 nodes · 12 edges"). */
  sublabel?: string
  className?: string
}) {
  return (
    <output className={cn("flex flex-col items-start gap-2", className)}>
      <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.24em] text-teal-400">
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
