import { describe, expect, it } from "vitest"
import {
  classifyUpgradeFailure,
  isTemporaryFailure,
  safeFailureSummary,
} from "./failure.js"

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
    [
      [
        "2 ingest steps failed after 3 attempts. A step reached its time limit.",
      ],
      "timeout",
      "ingest",
    ],
    [
      ["1 ingest step failed after 3 attempts. The model returned an error."],
      "model",
      "ingest",
    ],
    [["1 ingest step failed after 3 attempts."], "unknown", "ingest"],
    [
      [
        "no_writable_destination",
        "The ingestion run did not publish to this Workspace: the Workspace was not a destination of the run.",
      ],
      "workspace_write_access",
      "publish",
    ],
  ])("classifies %j as %s at %s", (report, code, step) => {
    expect(classifyUpgradeFailure(failed(report))).toMatchObject({ code, step })
  })

  it.each([
    "stdout maxBuffer length exceeded",
    "The Git repository is too large for ctx| to read in one step: the Git pack of its commit is 300 MiB, and the limit is 190 MiB.",
  ])("names a Git output that is too large as a known cause: %s", (failureReason) => {
    expect(
      classifyUpgradeFailure({ status: "failed", failureReason }),
    ).toMatchObject({ code: "repository_too_large", step: null })
  })

  it("names a Git command that took too long as a timeout", () => {
    expect(
      classifyUpgradeFailure({
        status: "failed",
        failureReason:
          "Git fetch did not finish in the time that ctx| waits (600 s).",
      }),
    ).toMatchObject({ code: "timeout", step: null })
  })

  it("does not classify by a repository name", () => {
    const input = failed([], "acme/model-sandbox-provider")
    expect(isTemporaryFailure(input)).toBe(false)
    expect(classifyUpgradeFailure(input)).toMatchObject({
      code: "unknown",
      repository: null,
    })
  })

  it("retries steps that failed with no known cause", () => {
    expect(
      isTemporaryFailure(failed(["2 ingest steps failed after 3 attempts."])),
    ).toBe(true)
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

describe("isTemporaryFailure", () => {
  it("retries a step time limit, but not a long wait for a turn or a run", () => {
    expect(
      isTemporaryFailure(
        failed([
          "1 ingest step failed after 3 attempts. A step reached its time limit.",
        ]),
      ),
    ).toBe(true)
    expect(
      isTemporaryFailure(
        failed([
          "The ingestion run did not finish in the time that the upgrade waits.",
        ]),
      ),
    ).toBe(false)
    expect(
      isTemporaryFailure({
        status: "failed",
        failureReason:
          "Another re-ingestion of this organization runs. The re-ingestion waited too long for its turn. Start it again.",
      }),
    ).toBe(false)
  })
})
