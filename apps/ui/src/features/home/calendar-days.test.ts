import { describe, expect, it } from "vitest"
import {
  calendarMonthTicks,
  commitLevel,
  formatCommitTooltip,
  toCalendarCells,
  utcSundayCount,
} from "./calendar-days"

describe("calendar-days", () => {
  it("maps UTC dates onto Sunday weeks and weekdays", () => {
    const cells = toCalendarCells([
      { date: "2026-08-02", count: 0 },
      { date: "2026-08-03", count: 2 },
      { date: "2026-08-09", count: 1 },
    ])
    expect(cells[0]).toMatchObject({
      week: 0,
      weekday: "Sun",
      level: "none",
    })
    expect(cells[1]).toMatchObject({
      week: 0,
      weekday: "Mon",
      level: "mid",
    })
    expect(cells[2]).toMatchObject({
      week: 1,
      weekday: "Sun",
      level: "low",
    })
  })

  it("counts Sunday-aligned weeks", () => {
    const start = new Date("2026-08-02T00:00:00.000Z")
    expect(utcSundayCount(start, new Date("2026-08-02T00:00:00.000Z"))).toBe(0)
    expect(utcSundayCount(start, new Date("2026-08-09T00:00:00.000Z"))).toBe(1)
  })

  it("labels the first day of each month", () => {
    const ticks = calendarMonthTicks(
      toCalendarCells([
        { date: "2026-07-26", count: 0 },
        { date: "2026-08-01", count: 0 },
        { date: "2026-08-02", count: 0 },
      ]),
    )
    expect(ticks.labels.get(0)).toBe("Jul")
    expect(ticks.labels.get(1)).toBe("Aug")
  })

  it("formats compact tooltips", () => {
    expect(formatCommitTooltip(1, "2026-08-12")).toBe(
      "1 commit on Aug 12, 2026",
    )
    expect(formatCommitTooltip(3, "2026-08-12")).toBe(
      "3 commits on Aug 12, 2026",
    )
  })

  it("uses contribution-style levels", () => {
    expect(commitLevel(0)).toBe("none")
    expect(commitLevel(1)).toBe("low")
    expect(commitLevel(3)).toBe("mid")
    expect(commitLevel(6)).toBe("high")
    expect(commitLevel(7)).toBe("hot")
  })
})
