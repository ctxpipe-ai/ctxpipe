import { describe, expect, it } from "vitest"
import { upgradeItemFixture } from "@/mocks/workspace-upgrades-handlers"
import { type UpgradeStatus, upgradePollInterval } from "./queries"

const poll = (...statuses: UpgradeStatus[]) =>
  upgradePollInterval(statuses.map((status) => upgradeItemFixture({ status })))

describe("upgrade polling", () => {
  it("polls every 3 s while an item is queued or running", () => {
    expect(poll("queued")).toBe(3_000)
    expect(poll("awaiting_operator", "running")).toBe(3_000)
  })

  it("polls every 15 s while an item waits for a merge or a click", () => {
    expect(poll("pr_open")).toBe(15_000)
    expect(poll("completed", "pr_open")).toBe(15_000)
    expect(poll("awaiting_operator")).toBe(15_000)
  })

  it("polls every 3 s after ctx| saw the merge, until the upgrade completes", () => {
    expect(
      upgradePollInterval([
        upgradeItemFixture({
          status: "pr_open",
          mergedAt: "2026-10-20T11:00:00.000Z",
        }),
      ]),
    ).toBe(3_000)
  })

  it("prefers the fast interval when both kinds are present", () => {
    expect(poll("pr_open", "running")).toBe(3_000)
  })

  it("stops when no item is queued, running, open or waiting for a click", () => {
    expect(poll()).toBe(false)
    expect(poll("failed", "blocked", "completed")).toBe(false)
    expect(upgradePollInterval(undefined)).toBe(false)
  })
})
