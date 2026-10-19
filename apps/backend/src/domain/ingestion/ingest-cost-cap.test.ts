import { expect, it } from "vitest"
import {
  INGEST_COST_CAP_RANGE,
  ingestionCostCapUsd,
  ingestUsageUsd,
} from "./ingest-cost-cap.js"

// The production bundle: three model skills for each root, four repository-wide.
const bundle = { rootModelSkills: 3, repositoryModelSkills: 4 }

it("gives a small repository the minimum cap", () => {
  expect(ingestionCostCapUsd({ ...bundle, roots: 1 })).toBe(
    INGEST_COST_CAP_RANGE.minUsd,
  )
})

it("scales the cap with the roots, so a large monorepo fits a full run", () => {
  // A monorepo with 4 shards of roots (about 70 roots) needs about 214
  // model steps. At $0.10 a step a full run costs about $21; the cap is 2
  // times that.
  const cap = ingestionCostCapUsd({ ...bundle, roots: 70 })
  expect(cap).toBeCloseTo(2 * (70 * 3 + 4) * 0.1)
  expect(cap).toBeGreaterThan(6.72)
  expect(cap).toBeGreaterThan(ingestionCostCapUsd({ ...bundle, roots: 20 }))
})

it("holds the cap at the maximum for a very large repository", () => {
  expect(ingestionCostCapUsd({ ...bundle, roots: 400 })).toBe(
    INGEST_COST_CAP_RANGE.maxUsd,
  )
})

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
