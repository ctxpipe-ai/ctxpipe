import { afterEach, describe, expect, it, vi } from "vitest"
import {
  INDEX_PIPELINE_IDLE_TTL_MS,
  releaseIndexPipelineReference,
  releaseIndexPipelineReservation,
  resetIndexPipelineAdmissionForTests,
  tryAcquireIndexPipeline,
} from "./indexPipelineAdmission.js"

describe("index pipeline admission", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    resetIndexPipelineAdmissionForTests()
  })

  it("allows overlapping phases on the same repo and keeps others out while sticky", () => {
    vi.stubEnv("CODESEARCH_INDEX_PIPELINE_CONCURRENCY", "1")
    expect(tryAcquireIndexPipeline("repo_a")).toEqual({ ok: true })
    expect(tryAcquireIndexPipeline("repo_a")).toEqual({ ok: true })
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(false)
    releaseIndexPipelineReference("repo_a")
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(false)
    releaseIndexPipelineReference("repo_a")
    expect(tryAcquireIndexPipeline("repo_a")).toEqual({ ok: true })
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(false)
    releaseIndexPipelineReference("repo_a")
    releaseIndexPipelineReservation("repo_a")
    expect(tryAcquireIndexPipeline("repo_b")).toEqual({ ok: true })
    releaseIndexPipelineReservation("repo_b")
  })

  it("caps distinct repos at CODESEARCH_INDEX_PIPELINE_CONCURRENCY", () => {
    vi.stubEnv("CODESEARCH_INDEX_PIPELINE_CONCURRENCY", "2")
    expect(tryAcquireIndexPipeline("repo_a").ok).toBe(true)
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(true)
    const denied = tryAcquireIndexPipeline("repo_c")
    expect(denied).toEqual({ ok: false })
    releaseIndexPipelineReference("repo_a")
    expect(tryAcquireIndexPipeline("repo_c").ok).toBe(false)
    releaseIndexPipelineReservation("repo_a")
    expect(tryAcquireIndexPipeline("repo_c").ok).toBe(true)
    releaseIndexPipelineReservation("repo_b")
    releaseIndexPipelineReservation("repo_c")
  })

  it("keeps the reservation after refs hit zero until reservation release", () => {
    vi.stubEnv("CODESEARCH_INDEX_PIPELINE_CONCURRENCY", "1")
    expect(tryAcquireIndexPipeline("repo_a").ok).toBe(true)
    releaseIndexPipelineReference("repo_a")
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(false)
    releaseIndexPipelineReservation("repo_a")
    expect(tryAcquireIndexPipeline("repo_b")).toEqual({ ok: true })
    releaseIndexPipelineReservation("repo_b")
  })

  it("expires a sticky reservation after the idle TTL", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.stubEnv("CODESEARCH_INDEX_PIPELINE_CONCURRENCY", "1")
    expect(tryAcquireIndexPipeline("repo_a").ok).toBe(true)
    releaseIndexPipelineReference("repo_a")
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(false)
    vi.setSystemTime(1_000 + INDEX_PIPELINE_IDLE_TTL_MS)
    expect(tryAcquireIndexPipeline("repo_b")).toEqual({ ok: true })
    releaseIndexPipelineReservation("repo_b")
  })
})
