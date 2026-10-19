import { describe, expect, it } from "vitest"
import { classifyUpgradeFailure, safeFailureSummary } from "./failure.js"

const failed = (report: string[], repository = "acme/ky") => ({
  status: "failed",
  failureReason: `The re-ingestion did not finish for ${repository}. Start it again.`,
  repositories: [{ repository, status: "partial", report }],
})

describe("classifyUpgradeFailure", () => {
  it("names the publish step and the merge cause of the CTX-895 failure", () => {
    expect(
      classifyUpgradeFailure(
        failed([
          "The semantic merge failed: The model did not call the structured output tool",
        ]),
      ),
    ).toEqual({
      code: "publish_conflict",
      step: "publish",
      repository: "acme/ky",
      summary:
        "The semantic merge failed: The model did not call the structured output tool",
    })
  })

  it.each([
    [
      [
        "ctx| cannot read the default branch of the repository. Repository not found.",
      ],
      "source_access",
      "read_source",
    ],
    [["The Workspace is not writable"], "workspace_write_access", "publish"],
    [
      ["The ingestion run failed: The ingest sandbox did not start"],
      "sandbox",
      "ingest",
    ],
    [
      ["The ingestion run failed: The model provider returned 429"],
      "model",
      "ingest",
    ],
    [
      ["The ingestion run did not finish in the time that the upgrade waits."],
      "timeout",
      "ingest",
    ],
    [["The ingestion run failed: something odd"], "unknown", "ingest"],
  ])("classifies %j as %s at %s", (report, code, step) => {
    expect(classifyUpgradeFailure(failed(report))).toMatchObject({ code, step })
  })

  it("reads a row error with no repository", () => {
    expect(
      classifyUpgradeFailure({
        status: "failed",
        failureReason:
          "The Workspace has 30 source repositories. One re-ingestion run handles at most 20.",
      }),
    ).toMatchObject({ code: "too_many_sources", step: "plan" })
    expect(
      classifyUpgradeFailure({
        status: "failed",
        failureReason: "ctx| could not queue the upgrade. Start it again.",
      }),
    ).toMatchObject({
      code: "unknown",
      summary: "ctx| could not queue the upgrade.",
    })
    expect(
      classifyUpgradeFailure({ status: "failed", failureReason: null }),
    ).toEqual({
      code: "unknown",
      step: null,
      repository: null,
      summary: "ctx| recorded no reason.",
    })
  })

  it("gives no failure for a row that did not fail", () => {
    expect(
      classifyUpgradeFailure({ status: "completed", failureReason: null }),
    ).toBeNull()
  })
})

describe("safeFailureSummary", () => {
  it("keeps one line with no stack frame and no credential", () => {
    expect(
      safeFailureSummary(
        "fatal: https://x-access-token:ghs_abcdefghijklmnopqrstuv@github.com/a/b failed token=abc\n    at run (/app/x.js:1:2)",
      ),
    ).toBe("fatal: https://github.com/a/b failed token=[hidden]")
    expect(safeFailureSummary("x".repeat(300))).toHaveLength(240)
  })
})
