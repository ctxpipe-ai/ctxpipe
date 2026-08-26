import { cell, defineChart } from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react"
import { scaleBand } from "@tanstack/charts/scales/band"
import { useMemo } from "react"
import { Skeleton } from "@/components/ui/Skeleton"
import type { WorkspaceActivityDay } from "@/features/workspaces/types"
import {
  calendarAriaLabel,
  calendarMonthTicks,
  CALENDAR_WEEKDAYS,
  COMMIT_LEVEL_COLORS,
  formatCommitTooltip,
  toCalendarCells,
} from "./calendar-days"

const WEEKDAY_TICKS = ["Mon", "Wed", "Fri"]

export function WorkspaceActivityHeatmap(props: {
  days: readonly WorkspaceActivityDay[]
}) {
  const cells = useMemo(() => toCalendarCells(props.days), [props.days])
  const weekCount = cells.reduce(
    (highest, cell) => Math.max(highest, cell.week + 1),
    0,
  )
  const weekDomain = useMemo(
    () => Array.from({ length: weekCount }, (_value, index) => index),
    [weekCount],
  )
  const monthTicks = useMemo(() => calendarMonthTicks(cells), [cells])
  const byKey = useMemo(
    () => new Map(cells.map((cell) => [cell.date, cell])),
    [cells],
  )

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          cell(cells, {
            x: "week",
            y: "weekday",
            color: (row) => COMMIT_LEVEL_COLORS[row.level],
            key: "date",
            inset: 1,
            radius: 2,
          }),
        ],
        x: {
          scale: () => scaleBand<number>().domain(weekDomain).padding(0.12),
          axis: {
            line: false,
            ticks: {
              values: monthTicks.values,
              size: 0,
              padding: 4,
              format: (week: number) => monthTicks.labels.get(week) ?? "",
            },
          },
        },
        y: {
          scale: () =>
            scaleBand<string>()
              .domain([...CALENDAR_WEEKDAYS])
              .padding(0.12),
          axis: {
            line: false,
            ticks: {
              values: WEEKDAY_TICKS,
              size: 0,
              padding: 4,
            },
          },
        },
        theme: {
          foreground: "rgb(161, 161, 170)",
          muted: "rgb(161, 161, 170)",
          grid: "transparent",
          background: "transparent",
        },
        focusRing: false,
        tooltip: {
          render: (datum: { date?: string; count?: number }) => {
            const row = datum.date ? byKey.get(datum.date) : undefined
            if (!row) return null
            return formatCommitTooltip(row.count, row.date)
          },
        },
        margin: { top: 16, right: 0, bottom: 0, left: 28 },
      }),
    [byKey, cells, monthTicks, weekDomain],
  )

  if (cells.length === 0) return null

  return (
    <Chart
      definition={definition}
      height={128}
      ariaLabel={calendarAriaLabel(cells)}
      className="text-xs text-muted-foreground"
    />
  )
}

export function WorkspaceActivityHeatmapSkeleton() {
  return (
    <div aria-busy className="w-full">
      <span className="sr-only">Loading activity</span>
      <Skeleton className="h-32 w-full rounded-lg" />
    </div>
  )
}
