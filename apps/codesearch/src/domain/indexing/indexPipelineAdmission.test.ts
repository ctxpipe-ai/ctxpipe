import { afterEach, describe, expect, it, vi } from "vitest"
import {
  resetIndexPipelineAdmissionForTests,
  tryAcquireIndexPipeline,
  releaseIndexPipeline,
} from "./indexPipelineAdmission.js"

describe("index pipeline admission", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetIndexPipelineAdmissionForTests()
  })

  it("allows overlapping phases on the same repo", () => {
    vi.stubEnv("CODESEARCH_INDEX_PIPELINE_CONCURRENCY", "1")
    expect(tryAcquireIndexPipeline("repo_a")).toEqual({ ok: true })
    expect(tryAcquireIndexPipeline("repo_a")).toEqual({ ok: true })
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(false)
    releaseIndexPipeline("repo_a")
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(false)
    releaseIndexPipeline("repo_a")
    expect(tryAcquireIndexPipeline("repo_b")).toEqual({ ok: true })
    releaseIndexPipeline("repo_b")
  })

  it("caps distinct repos at CODESEARCH_INDEX_PIPELINE_CONCURRENCY", () => {
    vi.stubEnv("CODESEARCH_INDEX_PIPELINE_CONCURRENCY", "2")
    expect(tryAcquireIndexPipeline("repo_a").ok).toBe(true)
    expect(tryAcquireIndexPipeline("repo_b").ok).toBe(true)
    const denied = tryAcquireIndexPipeline("repo_c")
    expect(denied).toEqual({ ok: false, retryAfterSeconds: 30 })
    releaseIndexPipeline("repo_a")
    expect(tryAcquireIndexPipeline("repo_c").ok).toBe(true)
    releaseIndexPipeline("repo_b")
    releaseIndexPipeline("repo_c")
  })
})
