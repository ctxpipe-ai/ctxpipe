import { describe, expect, it } from "vitest"
import type { WorkspaceUpgradeItem } from "./queries"
import {
  formatHealthLine,
  upgradeBlockedCopy,
  upgradeBlockedNextStep,
  upgradeCanCheck,
  upgradeCanStart,
  upgradeIsPending,
  upgradeNotices,
  upgradeStartedMessage,
  upgradeWaitingCopy,
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

  it("shows each notice one time, actions first, and keeps report lines out", () => {
    const risk = { kind: "risk" as const, text: "Some links are removed." }
    const action = { kind: "action" as const, text: "Fix the sources file." }
    const notices = upgradeNotices({
      steps: [
        {
          format: 1,
          title: "Export and sources",
          commitSha: null,
          report: ["notes/a.md: link 1 is removed."],
          notices: [risk, action],
        },
        // A step of a run before notices has none.
        { format: 2, title: "Sources", commitSha: null, report: ["x"] },
        {
          format: 3,
          title: "Ownership",
          commitSha: null,
          report: [],
          notices: [risk],
        },
      ],
    })
    expect(notices).toEqual([action, risk])
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

  it("names what an open item waits for, and the next step of a blocked re-ingestion", () => {
    expect(
      upgradeWaitingCopy({
        status: "pr_open",
        pullRequest: { number: 7, url: "https://example.com/pull/7" },
      }),
    ).toMatch(/waits for you to merge pull request #7/)
    expect(
      upgradeWaitingCopy({ status: "awaiting_operator", pullRequest: null }),
    ).toBeNull()
    const blocked = {
      kind: "reingest",
      status: "blocked",
      blockedReason: "needs_format",
    } as WorkspaceUpgradeItem
    expect(upgradeBlockedNextStep(blocked)).toMatch(/press Check again/)
    expect(upgradeCanCheck(blocked)).toBe(true)
    expect(upgradeCanCheck(item("pr_open"))).toBe(true)
    expect(upgradeCanCheck(item("awaiting_operator"))).toBe(false)
  })
})
