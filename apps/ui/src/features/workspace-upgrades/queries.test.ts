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

  it("prefers the fast interval when both kinds are present", () => {
    expect(poll("pr_open", "running")).toBe(3_000)
  })

  it("stops when no item is queued, running, open or waiting for a click", () => {
    expect(poll()).toBe(false)
    expect(poll("failed", "blocked", "completed")).toBe(false)
    expect(upgradePollInterval(undefined)).toBe(false)
  })
})

describe("upgrade polling after a format change (CTX-944)", () => {
  const blockedForFormat = upgradeItemFixture({
    kind: "reingest",
    status: "blocked",
    blockedReason: "needs_format",
    targetFormat: 3,
  })

  it("polls every 3 s while the scan has not caught up with the new format", () => {
    expect(upgradePollInterval([blockedForFormat], 3)).toBe(3_000)
  })

  it("does not poll a block that is current", () => {
    expect(upgradePollInterval([blockedForFormat], 2)).toBe(false)
    expect(upgradePollInterval([blockedForFormat])).toBe(false)
  })
})
