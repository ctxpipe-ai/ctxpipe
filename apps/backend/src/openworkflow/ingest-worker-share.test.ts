import { describe, expect, it } from "vitest"

import { ingestWorkerShare } from "./ingest-worker-share.js"

describe("ingestWorkerShare", () => {
  it("is half of the worker concurrency of the process, and at least 1", () => {
    expect(ingestWorkerShare({ OPENWORKFLOW_CONCURRENCY: "16" })).toBe(8)
    expect(ingestWorkerShare({ OPENWORKFLOW_CONCURRENCY: "5" })).toBe(2)
    expect(ingestWorkerShare({ OPENWORKFLOW_CONCURRENCY: "2" })).toBe(1)
    // The default concurrency (ADR-027) is 4.
    expect(ingestWorkerShare({})).toBe(2)
  })
})
