import type { WorkspaceActivityDay } from "@/features/workspaces/types"

export const CALENDAR_WEEKDAYS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const

export type CalendarWeekday = (typeof CALENDAR_WEEKDAYS)[number]

export const COMMIT_LEVELS = ["none", "low", "mid", "high", "hot"] as const
export type CommitLevel = (typeof COMMIT_LEVELS)[number]

export const COMMIT_LEVEL_COLORS: Record<CommitLevel, string> = {
  none: "#27272a",
  low: "#134e4a",
  mid: "#0f766e",
  high: "#14b8a6",
  hot: "#2dd4bf",
}

export type CalendarCell = {
  date: string
  count: number
  week: number
  weekday: CalendarWeekday
  level: CommitLevel
}

export function parseUtcDate(date: string): Date {
  const [year, month, day] = date.split("-").map(Number)
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
}

export function startOfUtcSunday(date: Date): Date {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
  day.setUTCDate(day.getUTCDate() - day.getUTCDay())
  return day
}

export function utcSundayCount(start: Date, date: Date): number {
  const startSunday = startOfUtcSunday(start)
  const dateSunday = startOfUtcSunday(date)
  return Math.round(
    (dateSunday.getTime() - startSunday.getTime()) / (7 * 86_400_000),
  )
}

export function commitLevel(count: number): CommitLevel {
  if (count <= 0) return "none"
  if (count === 1) return "low"
  if (count <= 3) return "mid"
  if (count <= 6) return "high"
  return "hot"
}

export function toCalendarCells(
  days: readonly WorkspaceActivityDay[],
): CalendarCell[] {
  const first = days[0]
  if (!first) return []
  const calendarStart = startOfUtcSunday(parseUtcDate(first.date))
  return days.map((day) => {
    const date = parseUtcDate(day.date)
    return {
      date: day.date,
      count: day.count,
      week: utcSundayCount(calendarStart, date),
      weekday: CALENDAR_WEEKDAYS[date.getUTCDay()] ?? "Sun",
      level: commitLevel(day.count),
    }
  })
}

export function calendarMonthTicks(cells: readonly CalendarCell[]): {
  values: number[]
  labels: Map<number, string>
} {
  const monthFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  })
  const labels = new Map<number, string>()
  for (const cell of cells) {
    const date = parseUtcDate(cell.date)
    if (date.getUTCDate() === 1 && !labels.has(cell.week)) {
      labels.set(cell.week, monthFormat.format(date))
    }
  }
  const first = cells[0]
  if (first && !labels.has(first.week)) {
    labels.set(first.week, monthFormat.format(parseUtcDate(first.date)))
  }
  return { values: [...labels.keys()], labels }
}

export function formatCommitTooltip(count: number, date: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parseUtcDate(date))
  return `${count} ${count === 1 ? "commit" : "commits"} on ${formatted}`
}

export function calendarAriaLabel(cells: readonly CalendarCell[]): string {
  const max = cells.reduce((highest, cell) => Math.max(highest, cell.count), 0)
  return `Workspace commit activity, 0 to ${max} commits per day`
}
