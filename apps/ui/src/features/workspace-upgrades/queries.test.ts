import { describe, expect, it } from "vitest"
import { upgradeItemFixture } from "@/mocks/workspace-upgrades-handlers"
import { checkingFormatExpired } from "./checking-format-clock"
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

  it("polls every 3 s after ctxpipe saw the merge, until the upgrade completes", () => {
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

  it("stops the 3 s poll when the checking state lasts more than a minute (CTX-949)", () => {
    const scope = "acme/docs"
    const checking = upgradeItemFixture({
      key: "reingest-bundle",
      kind: "reingest",
      status: "blocked",
      blockedReason: "needs_format",
    })
    checkingFormatExpired(`${scope}/${checking.key}`, false)
    expect(upgradePollInterval([checking], 3, scope)).toBe(3_000)
    // This client saw the state 61 s ago.
    checkingFormatExpired(`${scope}/${checking.key}`, false)
    checkingFormatExpired(`${scope}/${checking.key}`, true, Date.now() - 61_000)
    expect(upgradePollInterval([checking], 3, scope)).toBe(false)
    // A new checking state starts its minute again.
    expect(
      upgradePollInterval([{ ...checking, status: "completed" }], 3, scope),
    ).toBe(false)
    expect(upgradePollInterval([checking], 3, scope)).toBe(3_000)
    checkingFormatExpired(`${scope}/${checking.key}`, false)
  })
})
