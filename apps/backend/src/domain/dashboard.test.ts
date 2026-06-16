import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getOrgDbMock = vi.hoisted(() => vi.fn())
const getSystemDbMock = vi.hoisted(() => vi.fn())

vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
  getSystemDb: getSystemDbMock,
}))

import { getDashboardActivity } from "./dashboard.js"

type QueryRow = Record<string, unknown>

function dbForRows(rows: QueryRow[], terminal: "groupBy" | "where") {
  const chain = {
    from: vi.fn(() => chain),
    groupBy: vi.fn(() => Promise.resolve(rows)),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => (terminal === "where" ? Promise.resolve(rows) : chain)),
  }

  return {
    select: vi.fn(() => chain),
  }
}

describe("dashboard domain", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("normalizes aggregate activity timestamps returned as strings", async () => {
    getOrgDbMock.mockReturnValue(
      dbForRows(
        [
          {
            userId: "user_1",
            source: "ui",
            day: "2026-06-14",
            total: "2",
            lastActiveAt: "2026-06-14 10:15:00+00",
          },
          {
            userId: "user_1",
            source: "mcp",
            day: "2026-06-14",
            total: 1,
            lastActiveAt: new Date("2026-06-14T12:00:00.000Z"),
          },
        ],
        "groupBy",
      ),
    )
    getSystemDbMock.mockReturnValue(
      dbForRows(
        [
          {
            userId: "user_1",
            name: "Tom",
            email: "tom@example.com",
          },
        ],
        "where",
      ),
    )

    const activity = await getDashboardActivity({
      orgId: "org_1",
      userId: "user_1",
      range: "7d",
      includeMembers: true,
    })

    const yesterday = activity.buckets.find(
      (bucket) => bucket.date === "2026-06-14",
    )
    expect(yesterday?.organisation.total).toBe(3)
    expect(yesterday?.you.total).toBe(3)
    expect(activity.members).toEqual([
      {
        userId: "user_1",
        name: "Tom",
        email: "tom@example.com",
        total: 3,
        ui: 2,
        mcp: 1,
        graph: 0,
        repository: 0,
        other: 0,
        lastActiveAt: "2026-06-14T12:00:00.000Z",
      },
    ])
  })
})
