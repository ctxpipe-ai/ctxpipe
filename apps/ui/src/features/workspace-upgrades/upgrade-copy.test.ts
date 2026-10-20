import { describe, expect, it } from "vitest"
import type { WorkspaceUpgradeItem } from "./queries"
import {
  formatHealthLine,
  upgradeBlockedCopy,
  upgradeCanCheck,
  upgradeCanStart,
  upgradeIsCheckingFormat,
  upgradeIsPending,
  upgradeNotices,
  upgradeStartedMessage,
  upgradeStatusTag,
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
    // One action, also when the server note names two: the note is not used.
    expect(
      blocked(
        "reingest",
        "needs_format",
        "Re-ingestion needs format 3. Merge the format upgrade first.",
      ).body,
    ).toBe(
      "Re-ingestion needs format 3. Merge the format upgrade pull request, then press Check again.",
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
})
