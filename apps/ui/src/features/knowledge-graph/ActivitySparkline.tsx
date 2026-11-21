import { barY, defineChart, text } from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { useMemo } from "react"

import type { ActivityBuckets } from "./activity-buckets"

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})

const ZERO_BAR_FRACTION = 0.08
// Quiet bars (DESIGN.md: no large bright area). zinc-500 keeps 3:1 on the
// drawer surface, and the white count keeps 4.5:1 on the bar and on the
// darker bar under the pointer.
const BAR_FILL = "#71717a"
const BAR_FILL_HOVER = "#52525b"

type ActivityRow = {
  key: string
  count: number
  bar: number
  start: number
}

/**
 * A small weekly bar chart of the claims on one knowledge graph node, in the
 * node detail drawer. It tells the person when the node changed and how much.
 */
export function ActivitySparkline({ buckets }: { buckets: ActivityBuckets }) {
  const rows = useMemo<ActivityRow[]>(() => {
    const bucketCount = buckets.counts.length
    const bucketSize =
      bucketCount > 0
        ? (buckets.rangeEnd - buckets.rangeStart) / bucketCount
        : 0
    const max = buckets.counts.reduce((m, v) => (m > v ? m : v), 0)
    const floor = Math.max(max, 1) * ZERO_BAR_FRACTION
    return buckets.counts.map((count, i) => ({
      key: String(i),
      count,
      bar: count === 0 ? floor : count,
      start: buckets.rangeStart + i * bucketSize,
    }))
  }, [buckets])

  const definition = useMemo(() => {
    const byKey = new Map(rows.map((row) => [row.key, row]))
    const endKeys = [rows[0]?.key, rows.at(-1)?.key].filter(
      (key): key is string => key != null,
    )

    return defineChart({
      marks: [
        barY(rows, {
          x: "key",
          y: "bar",
          fill: BAR_FILL,
          radius: 2,
          states: [
            {
              when: { focus: "primary" },
              style: { fill: BAR_FILL_HOVER },
            },
          ],
        }),
        text(
          rows.filter((row) => row.count > 0),
          {
            x: "key",
            y: "bar",
            text: "count",
            fill: "#fafafa",
            fontSize: 12,
            fontWeight: 500,
            anchor: "middle",
            dy: 8,
          },
        ),
      ],
      x: {
        scale: () => scaleBand<string>().padding(0.2),
        axis: {
          line: false,
          ticks: {
            values: endKeys,
            size: 0,
            padding: 4,
            format: (key) => {
              const row = byKey.get(key)
              return row ? DATE_FORMATTER.format(new Date(row.start)) : ""
            },
          },
        },
      },
      y: {
        scale: scaleLinear,
        grid: false,
        axis: false,
      },
      theme: {
        foreground: "rgb(161, 161, 170)",
        muted: "rgb(161, 161, 170)",
        grid: "transparent",
        background: "transparent",
      },
      focusRing: false,
      tooltip: false,
      margin: { top: 0 },
    })
  }, [rows])

  if (rows.length === 0) return null

  return (
    <Chart
      definition={definition}
      height={96}
      ariaLabel={`Edge activity: ${buckets.total} observations`}
      className="text-xs text-muted-foreground"
    />
  )
}
