const MIN = 1
const MAX = 16

function parseBoundedInt(raw: string | undefined, defaultValue: number): number {
  if (raw == null || raw.trim() === "") return defaultValue
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(MAX, Math.max(MIN, parsed))
}

export function getIndexerProcessConcurrency(): number {
  return parseBoundedInt(process.env.CODESEARCH_INDEXER_CONCURRENCY, 2)
}

export function getIndexPipelineConcurrency(): number {
  return parseBoundedInt(process.env.CODESEARCH_INDEX_PIPELINE_CONCURRENCY, 2)
}
