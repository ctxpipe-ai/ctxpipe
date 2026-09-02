import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CODESEARCH_SIZE_CAPACITY,
  codesearchCapacityForMemoryMiB,
  codesearchCapacityForSize,
  DEFAULT_INDEXER_CONCURRENCY,
  DEFAULT_OPENWORKFLOW_CONCURRENCY,
  openworkflowWorkerStartArgs,
  parseIndexerConcurrency,
  parseIndexPipelineConcurrency,
  parseOpenWorkflowConcurrency,
  workerConcurrencyFromBudget,
} from "./codesearchCapacity.js"

describe("codesearchCapacityForMemoryMiB", () => {
  it("classifies CDK small below the kubernetes-gate peak as small", () => {
    expect(codesearchCapacityForMemoryMiB(4096).size).toBe("small")
    expect(codesearchCapacityForMemoryMiB(5670).size).toBe("small")
  })

  it("classifies CDK medium and large by memory", () => {
    expect(codesearchCapacityForMemoryMiB(8192)).toEqual(
      CODESEARCH_SIZE_CAPACITY.medium,
    )
    expect(codesearchCapacityForMemoryMiB(12288)).toEqual(
      CODESEARCH_SIZE_CAPACITY.large,
    )
  })
})

describe("workerConcurrencyFromBudget", () => {
  it("matches the size-profile tuples", () => {
    expect(
      workerConcurrencyFromBudget(
        CODESEARCH_SIZE_CAPACITY.small.clusterWorkflowBudget,
        1,
      ),
    ).toBe(6)
    expect(
      workerConcurrencyFromBudget(
        CODESEARCH_SIZE_CAPACITY.medium.clusterWorkflowBudget,
        1,
      ),
    ).toBe(10)
    expect(
      workerConcurrencyFromBudget(
        CODESEARCH_SIZE_CAPACITY.large.clusterWorkflowBudget,
        2,
      ),
    ).toBe(8)
  })

  it("does not drop below 2 when replica count is high", () => {
    expect(workerConcurrencyFromBudget(6, 10)).toBe(2)
  })
})

describe("parseOpenWorkflowConcurrency", () => {
  it("defaults to 4 when unset or invalid", () => {
    expect(parseOpenWorkflowConcurrency(undefined)).toBe(
      DEFAULT_OPENWORKFLOW_CONCURRENCY,
    )
    expect(parseOpenWorkflowConcurrency("")).toBe(
      DEFAULT_OPENWORKFLOW_CONCURRENCY,
    )
    expect(parseOpenWorkflowConcurrency("nope")).toBe(
      DEFAULT_OPENWORKFLOW_CONCURRENCY,
    )
  })

  it("clamps to 2..64", () => {
    expect(parseOpenWorkflowConcurrency("1")).toBe(2)
    expect(parseOpenWorkflowConcurrency("20")).toBe(20)
    expect(parseOpenWorkflowConcurrency("99")).toBe(64)
  })
})

describe("parseIndexerConcurrency", () => {
  it("defaults to 2 and clamps 1..16", () => {
    expect(parseIndexerConcurrency(undefined)).toBe(DEFAULT_INDEXER_CONCURRENCY)
    expect(parseIndexerConcurrency("0")).toBe(1)
    expect(parseIndexerConcurrency("32")).toBe(16)
  })
})

describe("parseIndexPipelineConcurrency", () => {
  it("defaults to 2", () => {
    expect(parseIndexPipelineConcurrency(undefined)).toBe(2)
    expect(parseIndexPipelineConcurrency("1")).toBe(1)
  })
})

describe("openworkflowWorkerStartArgs", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("passes the parsed concurrency flag", () => {
    vi.stubEnv("OPENWORKFLOW_CONCURRENCY", "6")
    expect(openworkflowWorkerStartArgs()).toEqual([
      "@openworkflow/cli",
      "worker",
      "start",
      "--concurrency",
      "6",
    ])
  })
})

describe("codesearchCapacityForSize", () => {
  it("keeps indexer slots from growing with large RAM", () => {
    expect(codesearchCapacityForSize("large").indexerConcurrency).toBe(2)
    expect(codesearchCapacityForSize("medium").indexerConcurrency).toBe(2)
    expect(codesearchCapacityForSize("small").indexerConcurrency).toBe(1)
  })
})
