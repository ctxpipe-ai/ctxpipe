import { getIndexPipelineConcurrency } from "./capacityEnv.js"

export const INDEX_PIPELINE_IDLE_TTL_MS = 180_000

type PipelineState = { refs: number; lastActivityMs: number }

const pipelines = new Map<string, PipelineState>()

function sweepExpiredReservations(now: number): void {
  for (const [repoId, state] of pipelines) {
    if (
      state.refs <= 0 &&
      now - state.lastActivityMs >= INDEX_PIPELINE_IDLE_TTL_MS
    ) {
      pipelines.delete(repoId)
    }
  }
}

export function tryAcquireIndexPipeline(
  repoId: string,
): { ok: true } | { ok: false } {
  const now = Date.now()
  sweepExpiredReservations(now)
  const existing = pipelines.get(repoId)
  if (existing) {
    existing.refs += 1
    existing.lastActivityMs = now
    return { ok: true }
  }
  if (pipelines.size >= getIndexPipelineConcurrency()) {
    return { ok: false }
  }
  pipelines.set(repoId, { refs: 1, lastActivityMs: now })
  return { ok: true }
}

export function releaseIndexPipelineReference(repoId: string): void {
  const existing = pipelines.get(repoId)
  if (!existing) return
  existing.refs = Math.max(0, existing.refs - 1)
  existing.lastActivityMs = Date.now()
}

export function releaseIndexPipelineReservation(repoId: string): void {
  pipelines.delete(repoId)
}

export function resetIndexPipelineAdmissionForTests(): void {
  pipelines.clear()
}
