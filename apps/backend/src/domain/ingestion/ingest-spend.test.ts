import { expect, it } from "vitest"

import { ingestUsageUsd } from "./ingest-spend.js"

it("uses the provider cost, else prices cache reads at the cache rate", () => {
  expect(
    ingestUsageUsd({ inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.5 }),
  ).toBe(0.5)
  // One million input tokens, of which 900,000 are cache reads: $0.30 of
  // fresh input and $0.27 of cache reads, not $3.
  expect(
    ingestUsageUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 900_000,
    }),
  ).toBeCloseTo(0.57)
})
