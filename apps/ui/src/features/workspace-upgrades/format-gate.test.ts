import { describe, expect, it } from "vitest"
import { upgradeItemFixture } from "@/mocks/workspace-upgrades-handlers"
import {
  formatUpgradeStatusLine,
  pendingFormatUpgrade,
  workspaceNeedsFormatUpgrade,
  workspaceUpgradesHref,
} from "./format-gate"

describe("workspaceNeedsFormatUpgrade", () => {
  it("needs the upgrade while a format upgrade is not applied", () => {
    for (const status of [
      "awaiting_operator",
      "queued",
      "running",
      "pr_open",
      "failed",
      "blocked",
    ] as const)
      expect(
        workspaceNeedsFormatUpgrade({
          items: [upgradeItemFixture({ status })],
        }),
      ).toBe(true)
  })

  it("needs the upgrade for a format below the newest, with no item yet", () => {
    for (const formatVersion of [0, 1, 2])
      expect(
        workspaceNeedsFormatUpgrade({
          items: [],
          formatVersion,
          codeFormat: 3,
        }),
      ).toBe(true)
  })

  it("needs nothing at the newest format", () => {
    expect(
      workspaceNeedsFormatUpgrade({
        items: [upgradeItemFixture({ status: "completed" })],
        formatVersion: 3,
        codeFormat: 3,
      }),
    ).toBe(false)
  })

  it("says nothing about a format that ctxpipe did not read, with no item", () => {
    expect(
      workspaceNeedsFormatUpgrade({
        items: [],
        formatVersion: null,
        codeFormat: 3,
      }),
    ).toBe(false)
    expect(workspaceNeedsFormatUpgrade({ items: undefined })).toBe(false)
  })

  it("does not call an upgrade the fix for a format file that is not valid or too new", () => {
    for (const formatVersion of [-1, 4])
      expect(
        workspaceNeedsFormatUpgrade({
          items: [],
          formatVersion,
          codeFormat: 3,
        }),
      ).toBe(false)
  })

  it("ignores a re-ingestion item", () => {
    expect(
      workspaceNeedsFormatUpgrade({
        items: [upgradeItemFixture({ kind: "reingest" })],
        formatVersion: 3,
        codeFormat: 3,
      }),
    ).toBe(false)
    expect(
      pendingFormatUpgrade([upgradeItemFixture({ kind: "reingest" })]),
    ).toBeUndefined()
  })
})

describe("format upgrade copy", () => {
  it("links to the Upgrades group of the Workspace settings", () => {
    expect(workspaceUpgradesHref("acme", "docs")).toBe(
      "/acme/ws/docs?pane=settings#upgrades",
    )
  })

  it("says where each state stands", () => {
    expect(formatUpgradeStatusLine(undefined)).toMatch(/has not found/)
    expect(formatUpgradeStatusLine({ status: "running", note: null })).toMatch(
      /preparing the upgrade pull request/,
    )
    expect(formatUpgradeStatusLine({ status: "pr_open", note: null })).toMatch(
      /Merge it on GitHub/,
    )
    expect(
      formatUpgradeStatusLine({ status: "blocked", note: "No write access." }),
    ).toMatch(/^No write access\. Press Review upgrade/)
    expect(
      formatUpgradeStatusLine({ status: "awaiting_operator", note: null }),
    ).toBe("")
  })
})
