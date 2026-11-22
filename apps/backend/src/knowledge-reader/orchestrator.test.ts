import { describe, expect, it } from "vitest"

import { JevError } from "../retrieval/jev/client.js"
import { BudgetSpentError, isBudgetSpent } from "./orchestrator.js"

describe("the end of the time budget", () => {
  it("is a Jev timeout only when the retrieval has a time budget", () => {
    const timeout = new JevError("timeout", "Jev gave no answer in 30000 ms.")
    expect(isBudgetSpent(timeout, performance.now() + 3_000)).toBe(true)
    // With no time budget (the evals), a Jev timeout is a failed call.
    expect(isBudgetSpent(timeout, Number.POSITIVE_INFINITY)).toBe(false)
    expect(
      isBudgetSpent(new BudgetSpentError("spent"), performance.now()),
    ).toBe(true)
    expect(
      isBudgetSpent(new JevError("http", "busy", 503), performance.now()),
    ).toBe(false)
  })
})
