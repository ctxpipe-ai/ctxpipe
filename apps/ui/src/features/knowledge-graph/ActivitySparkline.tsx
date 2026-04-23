import { useState } from "react"
import { FloatingPanel, PanelLabel } from "./FloatingPanel"

export type ActivityBuckets = {
  counts: number[]
  rangeStart: number
  rangeEnd: number
  total: number
}

const BUCKET_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})

export function ActivitySparkline({ buckets }: { buckets: ActivityBuckets }) {
  const max = buckets.counts.reduce((m, v) => (v > m ? v : m), 0)
  const [hovered, setHovered] = useState<number | null>(null)
  const bucketCount = buckets.counts.length
  const bucketSize =
    bucketCount > 0 ? (buckets.rangeEnd - buckets.rangeStart) / bucketCount : 0
  const hoveredStart =
    hovered != null ? buckets.rangeStart + hovered * bucketSize : null
  const hoveredEnd =
    hovered != null ? buckets.rangeStart + (hovered + 1) * bucketSize : null
  const hoveredCount = hovered != null ? (buckets.counts[hovered] ?? 0) : null

  return (
    <FloatingPanel
      className="flex w-[200px] flex-col gap-1.5 p-3"
      role="img"
      ariaLabel={`Edge activity: ${buckets.total} observations across ${buckets.counts.length} buckets`}
    >
      <div className="flex items-baseline justify-between">
        <PanelLabel>Activity</PanelLabel>
        <p className="font-mono text-[12px] tabular-nums text-zinc-400">
          {hoveredCount != null
            ? hoveredCount.toLocaleString()
            : buckets.total.toLocaleString()}
        </p>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-group container clears hover when the pointer leaves the whole sparkline; the bars below are the real interactive targets */}
      <div
        className="flex h-8 items-end gap-[2px]"
        onMouseLeave={() => setHovered(null)}
      >
        {buckets.counts.map((count, i) => {
          const h = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
          const isHovered = hovered === i
          const dimmed = hovered != null && !isHovered
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order positional buckets
              key={i}
              type="button"
              tabIndex={-1}
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
              className={`flex-1 cursor-default transition-opacity duration-100 ${isHovered ? "bg-teal-300" : "bg-teal-400/70"} ${dimmed ? "opacity-40" : ""}`}
              style={{ height: `${h}%` }}
              aria-label={`${count} edges`}
            />
          )
        })}
      </div>
      <div className="flex min-h-[14px] justify-between text-[12px] tabular-nums text-zinc-600">
        {hoveredStart != null && hoveredEnd != null ? (
          <span className="w-full text-center text-zinc-400">
            {BUCKET_FORMATTER.format(new Date(hoveredStart))} –{" "}
            {BUCKET_FORMATTER.format(new Date(hoveredEnd))}
          </span>
        ) : (
          <>
            <span>{BUCKET_FORMATTER.format(new Date(buckets.rangeStart))}</span>
            <span>{BUCKET_FORMATTER.format(new Date(buckets.rangeEnd))}</span>
          </>
        )}
      </div>
    </FloatingPanel>
  )
}
