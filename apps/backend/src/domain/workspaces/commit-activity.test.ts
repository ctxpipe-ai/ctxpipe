import { describe, expect, it } from "vitest"
import {
  activityCalendarDays,
  activityCalendarStart,
  firstLineSubject,
  mergeCommitPage,
  pruneCutoff,
  shouldSkipCommitProjection,
  startOfUtcSunday,
  utcDateKey,
} from "./commit-activity.js"

describe("commit activity", () => {
  it("builds a Sunday-aligned UTC calendar through today", () => {
    const now = new Date("2026-08-26T15:00:00.000Z")
    const days = activityCalendarDays({
      countsByDate: new Map([["2026-08-26", 3]]),
      now,
    })
    expect(days[0]?.date).toBe(utcDateKey(activityCalendarStart(now)))
    expect(new Date(`${days[0]?.date}T00:00:00.000Z`).getUTCDay()).toBe(0)
    expect(days.at(-1)?.date).toBe("2026-08-26")
    expect(days.at(-1)?.count).toBe(3)
    expect(days.filter((day) => day.count === 0).length).toBe(days.length - 1)
  })

  it("starts the week on Sunday", () => {
    expect(startOfUtcSunday(new Date("2026-08-26T12:00:00.000Z")).toISOString()).toBe(
      "2026-08-23T00:00:00.000Z",
    )
  })

  it("skips only a ready projection at the desired tip", () => {
    expect(
      shouldSkipCommitProjection({
        headSha: "abc",
        desiredSha: "abc",
        status: "ready",
      }),
    ).toBe(true)
    expect(
      shouldSkipCommitProjection({
        headSha: "abc",
        desiredSha: "def",
        status: "ready",
      }),
    ).toBe(false)
    expect(
      shouldSkipCommitProjection({
        headSha: "abc",
        desiredSha: "abc",
        status: "pending",
      }),
    ).toBe(false)
  })

  it("stops inserting once a known sha appears", () => {
    const merged = mergeCommitPage({
      existingShas: new Set(["known"]),
      commits: [
        {
          sha: "new",
          committedAt: new Date("2026-08-01T00:00:00.000Z"),
          authorName: "Ada",
          subject: "feat",
          htmlUrl: null,
        },
        {
          sha: "known",
          committedAt: new Date("2026-07-01T00:00:00.000Z"),
          authorName: "Ada",
          subject: "old",
          htmlUrl: null,
        },
      ],
    })
    expect(merged.hitKnownSha).toBe(true)
    expect(merged.toInsert.map((row) => row.sha)).toEqual(["new"])
  })

  it("takes the first subject line", () => {
    expect(firstLineSubject("Add heatmap\n\nBody")).toBe("Add heatmap")
    expect(firstLineSubject("")).toBe("Commit")
  })

  it("prunes after about thirteen months", () => {
    const cutoff = pruneCutoff(new Date("2026-08-26T00:00:00.000Z"))
    expect(cutoff.toISOString().startsWith("2025-07")).toBe(true)
  })
})
