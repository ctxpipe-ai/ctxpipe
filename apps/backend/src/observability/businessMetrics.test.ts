import { describe, expect, it } from "vitest"
import { connectorSyncTypeForEnqueuedWorkflow } from "./businessMetrics.js"

describe("connector sync metrics", () => {
  it("does not count the startup PR-mirror ensure sweep", () => {
    expect(
      connectorSyncTypeForEnqueuedWorkflow("github-ensure-pr-mirror"),
    ).toBeUndefined()
  })

  it("still counts a github content sync and skips ingestion workflows", () => {
    expect(connectorSyncTypeForEnqueuedWorkflow("github-sync-content")).toBe(
      "github",
    )
    expect(
      connectorSyncTypeForEnqueuedWorkflow("repository-ingestion"),
    ).toBeUndefined()
  })
})
