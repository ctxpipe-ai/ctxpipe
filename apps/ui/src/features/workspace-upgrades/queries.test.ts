import { describe, expect, it } from "vitest"
import {
  upgradeItemFixture,
  upgradesFixture,
} from "@/mocks/workspace-upgrades-handlers"
import { type UpgradeStatus, upgradePollInterval } from "./queries"

const poll = (...statuses: UpgradeStatus[]) =>
  upgradePollInterval(
    upgradesFixture(statuses.map((status) => upgradeItemFixture({ status }))),
  )

describe("upgrade polling", () => {
  it("polls every 3 s while an item is queued or running", () => {
    expect(poll("queued")).toBe(3_000)
    expect(poll("awaiting_operator", "running")).toBe(3_000)
  })

  it("polls every 15 s while an item waits for a merge", () => {
    expect(poll("pr_open")).toBe(15_000)
    expect(poll("completed", "pr_open")).toBe(15_000)
  })

  it("prefers the fast interval when both kinds are present", () => {
    expect(poll("pr_open", "running")).toBe(3_000)
  })

  it("stops when no item is queued, running or open", () => {
    expect(poll()).toBe(false)
    expect(poll("awaiting_operator", "failed", "blocked", "completed")).toBe(
      false,
    )
    expect(upgradePollInterval(undefined)).toBe(false)
  })
})
