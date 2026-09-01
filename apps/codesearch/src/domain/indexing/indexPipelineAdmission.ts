import { getIndexPipelineConcurrency } from "./capacityEnv.js"

export const INDEX_PIPELINE_RETRY_AFTER_SECONDS = 30

type PipelineState = { refs: number }

const pipelines = new Map<string, PipelineState>()

export function tryAcquireIndexPipeline(
  repoId: string,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const existing = pipelines.get(repoId)
  if (existing) {
    existing.refs += 1
    return { ok: true }
  }
  if (pipelines.size >= getIndexPipelineConcurrency()) {
    return {
      ok: false,
      retryAfterSeconds: INDEX_PIPELINE_RETRY_AFTER_SECONDS,
    }
  }
  pipelines.set(repoId, { refs: 1 })
  return { ok: true }
}

export function releaseIndexPipeline(repoId: string): void {
  const existing = pipelines.get(repoId)
  if (!existing) return
  existing.refs -= 1
  if (existing.refs <= 0) pipelines.delete(repoId)
}

export function resetIndexPipelineAdmissionForTests(): void {
  pipelines.clear()
}
