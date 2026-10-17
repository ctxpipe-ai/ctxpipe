import { describe, expect, it } from "vitest"
import type { WorkspaceUpgradeItem } from "./queries"
import {
  formatHealthLine,
  formatUpgradeEstimate,
  upgradeAlertLines,
  upgradeBlockedCopy,
  upgradeCanStart,
  upgradeIsPending,
  upgradeStartedMessage,
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

  it("words the start toast for each item kind", () => {
    expect(upgradeStartedMessage({ kind: "format" })).toMatch(/pull request/)
    expect(upgradeStartedMessage({ kind: "reingest" })).not.toMatch(
      /pull request/,
    )
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
    expect(formatHealthLine(4, 3)).toBe(
      "The repository uses format 4. ctx| reads format 3. This Workspace needs a newer ctx| version.",
    )
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
        [{ ...item("blocked"), kind: "format", blockedReason: "write_access" }],
        true,
      )[0],
    ).toMatch(/needs write access through the GitHub App/)
  })

  it("words a blocked item for its kind and reason, and prefers the note of the server", () => {
    const blocked = (
      kind: WorkspaceUpgradeItem["kind"],
      blockedReason: string | null,
      note: string | null = null,
    ) => upgradeBlockedCopy({ kind, blockedReason, note })
    expect(blocked("format", "write_access").title).toBe(
      "ctx| cannot open the upgrade pull request",
    )
    expect(blocked("reingest", "write_access").title).toBe(
      "ctx| cannot publish the re-ingestion",
    )
    expect(blocked("reingest", "write_access").body).not.toMatch(/pull request/)
    expect(blocked("reingest", "needs_format").title).toBe(
      "Apply the format upgrade first",
    )
    expect(blocked("reingest", "sandbox_unavailable").body).toMatch(
      /no ingest sandbox/,
    )
    expect(blocked("reingest", "ingestion_v2_off").body).toMatch(
      /valid format file/,
    )
    // A remote that is not GitHub: the note names the cause.
    expect(
      blocked("format", "write_access", "This remote is not GitHub.").body,
    ).toBe("This remote is not GitHub.")
    // No reason and no note: the body is never empty.
    expect(blocked("format", null)).toEqual({
      title: "The upgrade cannot start",
      body: "ctx| cannot start this item now.",
    })
  })

  it("words the estimate of a re-ingestion as a range", () => {
    expect(
      formatUpgradeEstimate({
        repositories: 2,
        costUsd: { low: 1.2, high: 4.8 },
        minutes: { low: 10, high: 30 },
        perRepository: [],
      }),
    ).toBe(
      "Estimated cost: $1.20 to $4.80 for 2 repositories, about 10 to 30 minutes.",
    )
  })
})
