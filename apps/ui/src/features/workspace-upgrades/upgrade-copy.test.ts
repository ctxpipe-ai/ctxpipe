import { describe, expect, it } from "vitest"
import { upgradeItemFixture } from "@/mocks/workspace-upgrades-handlers"
import type { WorkspaceUpgradeItem } from "./queries"
import {
  formatHealthLine,
  upgradeBlockedCopy,
  upgradeCanCheck,
  upgradeCanStart,
  upgradeGroup,
  upgradeHeadline,
  upgradeHistoryLine,
  upgradeIsCheckingFormat,
  upgradeNotices,
  upgradeSpendLine,
  upgradeStartedMessage,
  upgradeStatusTag,
  upgradeWaitingCopy,
} from "./upgrade-copy"

const item = (status: WorkspaceUpgradeItem["status"]) =>
  ({ status }) as WorkspaceUpgradeItem

describe("upgrade copy", () => {
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
      "The repository uses format 1. ctxpipe reads format 3.",
    )
    expect(formatHealthLine(3, 3)).toBe("Format 3")
    expect(formatHealthLine(4, 3)).toBe(
      "The repository uses format 4. ctxpipe reads format 3. This Workspace needs a newer ctxpipe version.",
    )
  })

  it("words a blocked item for its kind and reason, and prefers the note of the server", () => {
    const blocked = (
      kind: WorkspaceUpgradeItem["kind"],
      blockedReason: string | null,
      note: string | null = null,
    ) => upgradeBlockedCopy({ kind, blockedReason, note, targetFormat: 3 })
    expect(blocked("format", "write_access").title).toBe(
      "ctxpipe cannot open the upgrade pull request",
    )
    expect(blocked("reingest", "write_access").title).toBe(
      "ctxpipe cannot publish the re-ingestion",
    )
    expect(blocked("reingest", "write_access").body).not.toMatch(/pull request/)
    expect(blocked("reingest", "needs_format").title).toBe(
      "Apply the format upgrade first",
    )
    // One action, also when the server note names two: the note is not used.
    expect(
      blocked(
        "reingest",
        "needs_format",
        "Re-ingestion needs format 3. Merge the format upgrade first.",
      ).body,
    ).toBe(
      "Re-ingestion needs format 3. Finish the format upgrade, then press Check again.",
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
      body: "ctxpipe cannot start this item now.",
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
    expect(
      upgradeWaitingCopy(
        {
          status: "running",
          pullRequest: null,
          waitingForSlot: {
            reason: "The slots are full.",
            since: "2026-10-20T10:00:00.000Z",
          },
        },
        Date.parse("2026-10-20T11:05:30.000Z"),
      ),
    ).toMatch(/Waiting for a free sandbox for 1 h 5 min\. The slots are full\./)
    const blocked = {
      kind: "reingest",
      status: "blocked",
      blockedReason: "needs_format",
    } as WorkspaceUpgradeItem
    expect(upgradeCanCheck(blocked)).toBe(true)
    expect(upgradeCanCheck(item("pr_open"))).toBe(true)
    expect(upgradeCanCheck(item("awaiting_operator"))).toBe(false)
  })

  it("tags a merged pull request and a running re-ingestion for what they do", () => {
    const tag = (overrides: Partial<WorkspaceUpgradeItem>) =>
      upgradeStatusTag(upgradeItemFixture(overrides)).label
    expect(
      tag({ status: "pr_open", mergedAt: "2026-10-20T11:00:00.000Z" }),
    ).toBe("Merged. Reading the new format")
    expect(tag({ status: "running", kind: "reingest" })).toBe(
      "Re-ingesting the sources",
    )
    expect(tag({ status: "running", kind: "format" })).toBe(
      "Preparing the pull request",
    )
  })

  it("gives no wait line for a merged pull request: its progress block says what ctxpipe does", () => {
    expect(
      upgradeWaitingCopy({
        status: "pr_open",
        pullRequest: null,
        mergedAt: "2026-10-20T11:00:00.000Z",
      }),
    ).toBeNull()
  })
})

describe("a re-ingestion that waits for the scan after the format changed (CTX-944)", () => {
  const blockedForFormat = {
    kind: "reingest",
    status: "blocked",
    blockedReason: "needs_format",
    targetFormat: 3,
    waitingForSlot: null,
  } as const

  it("is checking when the Workspace has the format that the item needs", () => {
    expect(upgradeIsCheckingFormat(blockedForFormat, 3)).toBe(true)
    expect(upgradeIsCheckingFormat(blockedForFormat, 4)).toBe(true)
    expect(upgradeStatusTag(blockedForFormat, 3).label).toBe(
      "Checking the new format",
    )
  })

  it("stays blocked while the format is lower, unread or not valid", () => {
    expect(upgradeIsCheckingFormat(blockedForFormat, 2)).toBe(false)
    expect(upgradeIsCheckingFormat(blockedForFormat, null)).toBe(false)
    expect(upgradeIsCheckingFormat(blockedForFormat, -1)).toBe(false)
    expect(upgradeStatusTag(blockedForFormat, 2).label).toBe("Blocked")
  })

  it("does not change a block for another reason or another kind", () => {
    expect(
      upgradeIsCheckingFormat(
        { ...blockedForFormat, blockedReason: "write_access" },
        3,
      ),
    ).toBe(false)
    expect(
      upgradeIsCheckingFormat({ ...blockedForFormat, kind: "format" }, 3),
    ).toBe(false)
  })

  it("names the target format in the needs-format line", () => {
    const blocked = (targetFormat: number) =>
      upgradeBlockedCopy({
        kind: "reingest",
        blockedReason: "needs_format",
        note: "Merge the format upgrade first, or give write access.",
        targetFormat,
      })
    expect(blocked(3).body).toContain("needs format 3.")
    expect(blocked(4).body).toContain("needs format 4.")
  })
})

describe("the Status group says if the user must act (CTX-980)", () => {
  const fixture = upgradeItemFixture

  it("puts each item that waits for a person in Needs you", () => {
    expect(upgradeGroup(fixture({ status: "awaiting_operator" }), 3)).toBe(
      "needs_you",
    )
    expect(upgradeGroup(fixture({ status: "failed" }), 3)).toBe("needs_you")
    expect(upgradeGroup(fixture({ status: "blocked" }), 3)).toBe("needs_you")
    expect(
      upgradeGroup(
        fixture({
          status: "pr_open",
          pullRequest: { number: 5, url: "https://github.com/a/b/pull/5" },
        }),
        3,
      ),
    ).toBe("needs_you")
  })

  it("puts each item that ctxpipe works on in Working now", () => {
    expect(upgradeGroup(fixture({ status: "queued" }), 3)).toBe("working")
    expect(upgradeGroup(fixture({ status: "running" }), 3)).toBe("working")
    expect(
      upgradeGroup(
        fixture({
          status: "running",
          waitingForSlot: { reason: "Full.", since: "2026-10-16T10:00:00Z" },
        }),
        3,
      ),
    ).toBe("working")
    expect(
      upgradeGroup(
        fixture({ status: "pr_open", mergedAt: "2026-10-16T10:00:00Z" }),
        3,
      ),
    ).toBe("working")
    // A re-ingestion that waits for the scan after the format changed.
    expect(
      upgradeGroup(
        fixture({
          kind: "reingest",
          status: "blocked",
          blockedReason: "needs_format",
          targetFormat: 3,
        }),
        3,
      ),
    ).toBe("working")
    expect(upgradeGroup(fixture({ status: "completed" }), 3)).toBe("done")
  })

  it("gives the headline of the most urgent group", () => {
    const groups = (...items: WorkspaceUpgradeItem[]) =>
      items.map((entry) => upgradeGroup(entry, 3))
    const needs = upgradeHeadline(
      groups(fixture({ status: "running" }), fixture({ status: "failed" })),
    )
    expect(needs.label).toBe("Needs you")
    expect(needs.line).toBe("Action needed. 1 item needs you.")
    const working = upgradeHeadline(groups(fixture({ status: "queued" })))
    expect(working.label).toBe("Working")
    expect(working.pulse).toBe(true)
    expect(working.line).toMatch(/^No action needed\./)
    const done = upgradeHeadline(groups(fixture({ status: "completed" })))
    expect(done.label).toBe("Up to date")
    expect(done.line).toBe(
      "No action needed. Upgrades show here and on Home when one is ready.",
    )
    expect(upgradeHeadline([]).label).toBe("Up to date")
  })

  it("says the spend of a re-ingestion so far, and 'at least' when a part is unknown", () => {
    const repository = (
      spendUsd: number | null,
      spendUnknown = false,
    ): WorkspaceUpgradeItem["repositories"][number] => ({
      repository: "acme/api",
      sha: null,
      runId: null,
      status: "done",
      report: [],
      spendUsd,
      spendUnknown,
    })
    expect(
      upgradeSpendLine(
        fixture({
          kind: "reingest",
          repositories: [repository(1.2), repository(0.05)],
        }),
      ),
    ).toBe("Spend so far: $1.25")
    expect(
      upgradeSpendLine(
        fixture({
          kind: "reingest",
          repositories: [repository(1.2), repository(null, true)],
        }),
      ),
    ).toBe("Spend so far: at least $1.20")
    expect(
      upgradeSpendLine(
        fixture({ kind: "reingest", repositories: [repository(null)] }),
      ),
    ).toBeNull()
    expect(upgradeSpendLine(fixture({ kind: "format" }))).toBeNull()
  })

  it("gives History a count and the date of the last applied item", () => {
    expect(
      upgradeHistoryLine([
        fixture({ updatedAt: "2026-10-12T10:00:00.000Z" }),
        fixture({ updatedAt: "2026-10-21T10:00:00.000Z" }),
      ]),
    ).toBe("History · 2 applied, last on Oct 21")
    expect(upgradeHistoryLine([fixture()])).toBe(
      "History · 1 applied, last on Oct 16",
    )
  })
})
