import { cell, defineChart } from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react/tooltip"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal"
import { tooltip } from "@tanstack/charts/tooltip"
import { useMemo } from "react"
import { Skeleton } from "@/components/ui/Skeleton"
import type { WorkspaceActivityDay } from "@/features/workspaces/types"
import { cn } from "@/lib/utils"
import {
  CALENDAR_WEEKDAYS,
  COMMIT_LEVEL_COLORS,
  COMMIT_LEVELS,
  calendarAriaLabel,
  calendarMonthTicks,
  formatCommitTooltip,
  toCalendarCells,
} from "./calendar-days"

/** A click or Enter on a day calls `onSelectDate`; `selectedDate` gets an outline. */
export function WorkspaceActivityHeatmap(props: {
  days: readonly WorkspaceActivityDay[]
  selectedDate?: string | null
  onSelectDate?: (date: string) => void
}) {
  const cells = useMemo(() => toCalendarCells(props.days), [props.days])
  const selectedCells = useMemo(
    () => cells.filter((cell) => cell.date === props.selectedDate),
    [cells, props.selectedDate],
  )
  const weekCount = cells.reduce(
    (highest, cell) => Math.max(highest, cell.week + 1),
    0,
  )
  const weekDomain = useMemo(
    () => Array.from({ length: weekCount }, (_value, index) => index),
    [weekCount],
  )
  const monthTicks = useMemo(() => calendarMonthTicks(cells), [cells])

  const definition = useMemo(
    () =>
      defineChart(
        {
          marks: [
            cell(cells, {
              x: "week",
              y: "weekday",
              color: "level",
              key: "date",
              inset: 1,
              radius: 2,
            }),
            cell(selectedCells, {
              id: "selected-day",
              x: "week",
              y: "weekday",
              key: "date",
              inset: 1,
              radius: 2,
              fill: "transparent",
              stroke: "#fafafa",
              strokeWidth: 1.5,
            }),
          ],
          color: {
            scale: () =>
              scaleOrdinal(
                [...COMMIT_LEVELS],
                COMMIT_LEVELS.map((level) => COMMIT_LEVEL_COLORS[level]),
              ),
          },
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
                values: [...CALENDAR_WEEKDAYS],
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
          margin: { top: 0, right: 0, bottom: 0, left: 28 },
        },
        {
          tooltip: {
            use: tooltip,
            format: (point) =>
              formatCommitTooltip(point.datum.count, point.datum.date),
          },
        },
      ),
    [cells, monthTicks, selectedCells, weekDomain],
  )

  if (cells.length === 0) return null

  const onSelectDate = props.onSelectDate
  return (
    <Chart
      definition={definition}
      height={128}
      ariaLabel={calendarAriaLabel(cells)}
      ariaDescription={
        onSelectDate
          ? "Use the arrow keys to move between days. Press Enter to show the commits of a day."
          : undefined
      }
      onSelect={
        onSelectDate
          ? (point) => {
              if (point) onSelectDate(point.datum.date)
            }
          : undefined
      }
      className={cn(
        "h-32 w-full min-w-0 text-xs text-muted-foreground",
        onSelectDate && "cursor-pointer",
      )}
    />
  )
}

export function WorkspaceActivityHeatmapSkeleton() {
  return (
    <div aria-busy className="w-full pl-7">
      <span className="sr-only">Loading activity</span>
      <Skeleton className="block h-32 w-full" />
    </div>
  )
}
