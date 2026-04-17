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
  return (
    <FloatingPanel
      className="flex w-[200px] flex-col gap-1.5 p-3"
      role="img"
      ariaLabel={`Edge activity: ${buckets.total} observations across ${buckets.counts.length} buckets`}
    >
      <div className="flex items-baseline justify-between">
        <PanelLabel>Activity</PanelLabel>
        <p className="font-mono text-[10px] tabular-nums text-zinc-400">
          {buckets.total.toLocaleString()}
        </p>
      </div>
      <div className="flex h-8 items-end gap-[2px]">
        {buckets.counts.map((count, i) => {
          const h = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order positional buckets
              key={i}
              className="flex-1 bg-teal-400/70"
              style={{ height: `${h}%` }}
              title={`${count} edge${count === 1 ? "" : "s"}`}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-[9px] tabular-nums text-zinc-600">
        <span>{BUCKET_FORMATTER.format(new Date(buckets.rangeStart))}</span>
        <span>{BUCKET_FORMATTER.format(new Date(buckets.rangeEnd))}</span>
      </div>
    </FloatingPanel>
  )
}
