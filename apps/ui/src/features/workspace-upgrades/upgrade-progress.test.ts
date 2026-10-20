import { describe, expect, it } from "vitest"
import { upgradeItemFixture } from "@/mocks/workspace-upgrades-handlers"
import {
  formatElapsed,
  upgradeCheckResult,
  upgradeProgress,
} from "./upgrade-progress"

describe("formatElapsed", () => {
  const since = "2026-10-20T10:00:00.000Z"
  const at = (seconds: number) => Date.parse(since) + seconds * 1000
  it("counts seconds, minutes and hours", () => {
    expect(formatElapsed(since, at(45))).toBe("45 s")
    expect(formatElapsed(since, at(200))).toBe("3 min 20 s")
    expect(formatElapsed(since, at(3900))).toBe("1 h 5 min")
  })
  it("never shows a negative time", () => {
    expect(formatElapsed(since, at(-5))).toBe("0 s")
  })
})

describe("upgradeProgress", () => {
  const approvedAt = "2026-10-20T10:00:00.000Z"

  it("gives no progress to an item that waits for a person or ended", () => {
    for (const status of [
      "awaiting_operator",
      "completed",
      "failed",
      "blocked",
      "pr_open",
    ] as const)
      expect(upgradeProgress(upgradeItemFixture({ status }))).toBeNull()
  })

  it("shows the stage of a git run as a step of four", () => {
    const progress = upgradeProgress(
      upgradeItemFixture({
        status: "running",
        approvedAt,
        runStage: { name: "build", since: "2026-10-20T10:00:20.000Z" },
      }),
    )
    expect(progress).toEqual({
      label: "Making the upgrade commits",
      count: "Step 2 of 4",
      fraction: 0.25,
      detail: null,
      since: approvedAt,
    })
  })

  it("starts a git run with no stage at zero", () => {
    expect(
      upgradeProgress(upgradeItemFixture({ status: "running", approvedAt })),
    ).toMatchObject({ label: "Starting the run", count: null, fraction: 0 })
    expect(
      upgradeProgress(upgradeItemFixture({ status: "queued", approvedAt })),
    ).toMatchObject({ label: "Queued. ctx| starts the run in a moment." })
  })

  it("counts the repositories that a re-ingestion finished", () => {
    const progress = upgradeProgress(
      upgradeItemFixture({
        kind: "reingest",
        status: "running",
        approvedAt,
        repositories: [
          { repository: "acme/api", status: "done" },
          { repository: "acme/web", status: "pending" },
          { repository: "acme/docs", status: "pending" },
        ].map((repository) => ({
          sha: null,
          runId: null,
          report: [],
          spendUsd: null,
          spendUnknown: false,
          ...repository,
        })) as never,
      }),
    )
    expect(progress).toMatchObject({
      label: "Reading the source repositories",
      count: "1 of 3 repositories done",
      detail: "Now: acme/web",
      since: approvedAt,
    })
    expect(progress?.fraction).toBeCloseTo(1 / 3)
  })

  it("pulses while a re-ingestion plans its run, and shows nothing while it waits for a slot", () => {
    expect(
      upgradeProgress(
        upgradeItemFixture({ kind: "reingest", status: "running", approvedAt }),
      ),
    ).toMatchObject({ label: "Planning the run", fraction: null })
    expect(
      upgradeProgress(
        upgradeItemFixture({
          kind: "reingest",
          status: "running",
          waitingForSlot: { reason: "Full.", since: approvedAt },
        }),
      ),
    ).toBeNull()
  })

  it("says that ctx| saw the merge and what comes next", () => {
    const progress = upgradeProgress(
      upgradeItemFixture({
        status: "pr_open",
        mergedAt: "2026-10-20T11:00:00.000Z",
      }),
    )
    expect(progress?.label).toBe("Merged. Reading the new format…")
    expect(progress?.detail).toContain("completes this upgrade")
    expect(progress?.since).toBe("2026-10-20T11:00:00.000Z")
  })
})

describe("upgradeCheckResult", () => {
  const checkedAt = "2026-10-20T11:00:00.000Z"
  const prefix = /^Last check at \d{1,2}:\d{2}/

  it("says nothing before the first check", () => {
    expect(
      upgradeCheckResult(upgradeItemFixture({ status: "pr_open" }), 2),
    ).toBeNull()
  })

  it("names what the check found for each state", () => {
    const open = upgradeCheckResult(
      upgradeItemFixture({
        status: "pr_open",
        checkedAt,
        pullRequest: { number: 42, url: "https://example.test/pull/42" },
      }),
      2,
    )
    expect(open).toMatch(prefix)
    expect(open).toContain("Pull request #42 is still open on GitHub")
    expect(
      upgradeCheckResult(
        upgradeItemFixture({
          status: "pr_open",
          checkedAt,
          mergedAt: checkedAt,
        }),
        2,
      ),
    ).toContain("The pull request merged. ctx| is reading the new format.")
    expect(
      upgradeCheckResult(
        upgradeItemFixture({ status: "awaiting_operator", checkedAt }),
        2,
      ),
    ).toContain("found no open pull request")
    expect(
      upgradeCheckResult(
        upgradeItemFixture({
          kind: "reingest",
          status: "blocked",
          blockedReason: "needs_format",
          checkedAt,
        }),
        2,
      ),
    ).toContain("The Workspace uses format 2. This item needs format 3.")
    expect(
      upgradeCheckResult(
        upgradeItemFixture({ status: "completed", checkedAt }),
        3,
      ),
    ).toContain("The upgrade is applied.")
  })

  it("says nothing while a run works", () => {
    expect(
      upgradeCheckResult(
        upgradeItemFixture({ status: "running", checkedAt }),
        2,
      ),
    ).toBeNull()
  })
})
