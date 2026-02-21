import { describe, expect, it } from "vitest"
import {
  CLAIM_NEXT_JOB_QUERY,
  nextWorkerDelayMs,
  shouldMoveToErrorLog,
} from "../src/domain/codeIngestion/worker.js"

describe("code ingestion worker policy", () => {
  it("retries exactly two times before moving to error log", () => {
    expect(shouldMoveToErrorLog(0)).toBe(false)
    expect(shouldMoveToErrorLog(1)).toBe(false)
    expect(shouldMoveToErrorLog(2)).toBe(true)
  })

  it("enforces per-repository serialization in claim query", () => {
    expect(CLAIM_NEXT_JOB_QUERY).toContain("FOR UPDATE SKIP LOCKED")
    expect(CLAIM_NEXT_JOB_QUERY).toContain("NOT EXISTS")
    expect(CLAIM_NEXT_JOB_QUERY).toContain(
      "q2.status IN ('pending', 'processing')",
    )
  })

  it("uses shorter delay when work was processed", () => {
    expect(nextWorkerDelayMs(true)).toBeLessThan(nextWorkerDelayMs(false))
  })
})
