import { describe, expect, it } from "vitest"
import type { WorkspaceUpgradeItem } from "./queries"
import {
  formatHealthLine,
  upgradeAlertLines,
  upgradeCanStart,
  upgradeIsPending,
} from "./upgrade-copy"

const item = (status: WorkspaceUpgradeItem["status"]) =>
  ({ status }) as WorkspaceUpgradeItem

describe("upgrade copy", () => {
  it("counts every status except completed as pending", () => {
    expect(upgradeIsPending(item("completed"))).toBe(false)
    expect(upgradeIsPending(item("awaiting_operator"))).toBe(true)
    expect(upgradeIsPending(item("pr_open"))).toBe(true)
    expect(upgradeIsPending(item("blocked"))).toBe(true)
  })

  it("starts only a waiting or failed item", () => {
    expect(upgradeCanStart(item("awaiting_operator"))).toBe(true)
    expect(upgradeCanStart(item("failed"))).toBe(true)
    expect(upgradeCanStart(item("queued"))).toBe(false)
    expect(upgradeCanStart(item("blocked"))).toBe(false)
  })

  it("words the health line for each format state", () => {
    expect(formatHealthLine(null, 3)).toMatch(/has not read/)
    expect(formatHealthLine(-1, 3)).toMatch(/not valid/)
    expect(formatHealthLine(1, 3)).toBe(
      "The repository uses format 1. ctx| reads format 3.",
    )
    expect(formatHealthLine(3, 3)).toMatch(/up to date/)
  })

  it("words the alert from the statuses that are present", () => {
    expect(upgradeAlertLines([item("awaiting_operator")], true)).toEqual([
      "An owner or admin must start it.",
    ])
    expect(upgradeAlertLines([item("failed")], false)).toEqual([
      "Ask an admin to start it.",
    ])
    expect(
      upgradeAlertLines(
        [item("queued"), item("running"), item("pr_open")],
        null,
      ),
    ).toEqual([
      "An upgrade is running.",
      "Review and merge the upgrade pull request.",
    ])
    expect(
      upgradeAlertLines(
        [{ ...item("blocked"), blockedReason: "write_access" }],
        true,
      )[0],
    ).toMatch(/cannot write to the repository/)
  })
})
