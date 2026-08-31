/**
 * Codesearch is a single replica. OpenWorkflow worker concurrency, indexer
 * spawn slots, and in-flight index pipelines are derived from that instance's
 * memory. CDK size profiles and Railway/Compose env must stay aligned with
 * this table (see ADR-027).
 */

export type CodesearchSizeClass = "small" | "medium" | "large"

export type CodesearchCapacity = {
  readonly size: CodesearchSizeClass
  readonly memoryMiB: number
  readonly indexerConcurrency: number
  readonly indexPipelineConcurrency: number
  readonly clusterWorkflowBudget: number
}

export const DEFAULT_OPENWORKFLOW_CONCURRENCY = 4
export const DEFAULT_INDEXER_CONCURRENCY = 2
export const DEFAULT_INDEX_PIPELINE_CONCURRENCY = 2

const MIN_WORKER_CONCURRENCY = 2
const MAX_WORKER_CONCURRENCY = 64
const MIN_INDEXER_CONCURRENCY = 1
const MAX_INDEXER_CONCURRENCY = 16

export const CODESEARCH_SIZE_CAPACITY: Record<
  CodesearchSizeClass,
  CodesearchCapacity
> = {
  small: {
    size: "small",
    memoryMiB: 4096,
    indexerConcurrency: 1,
    indexPipelineConcurrency: 1,
    clusterWorkflowBudget: 6,
  },
  medium: {
    size: "medium",
    memoryMiB: 8192,
    indexerConcurrency: 2,
    indexPipelineConcurrency: 2,
    clusterWorkflowBudget: 10,
  },
  large: {
    size: "large",
    memoryMiB: 12288,
    indexerConcurrency: 2,
    indexPipelineConcurrency: 2,
    clusterWorkflowBudget: 16,
  },
}

export function codesearchCapacityForSize(
  size: CodesearchSizeClass,
): CodesearchCapacity {
  return CODESEARCH_SIZE_CAPACITY[size]
}

/** kubernetes-class ingest peaks around 5.2 GiB; treat below 6 GiB as small. */
export function codesearchCapacityForMemoryMiB(
  memoryMiB: number,
): CodesearchCapacity {
  if (memoryMiB < 6144) return CODESEARCH_SIZE_CAPACITY.small
  if (memoryMiB < 10240) return CODESEARCH_SIZE_CAPACITY.medium
  return CODESEARCH_SIZE_CAPACITY.large
}

export function workerConcurrencyFromBudget(
  clusterWorkflowBudget: number,
  workerReplicas: number,
): number {
  const replicas = Math.max(1, workerReplicas)
  return Math.max(
    MIN_WORKER_CONCURRENCY,
    Math.floor(clusterWorkflowBudget / replicas),
  )
}

function parseBoundedInt(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw.trim() === "") return defaultValue
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(max, Math.max(min, parsed))
}

export function parseOpenWorkflowConcurrency(raw: string | undefined): number {
  return parseBoundedInt(
    raw,
    DEFAULT_OPENWORKFLOW_CONCURRENCY,
    MIN_WORKER_CONCURRENCY,
    MAX_WORKER_CONCURRENCY,
  )
}

export function parseIndexerConcurrency(raw: string | undefined): number {
  return parseBoundedInt(
    raw,
    DEFAULT_INDEXER_CONCURRENCY,
    MIN_INDEXER_CONCURRENCY,
    MAX_INDEXER_CONCURRENCY,
  )
}

export function parseIndexPipelineConcurrency(raw: string | undefined): number {
  return parseBoundedInt(
    raw,
    DEFAULT_INDEX_PIPELINE_CONCURRENCY,
    MIN_INDEXER_CONCURRENCY,
    MAX_INDEXER_CONCURRENCY,
  )
}

export function openworkflowWorkerStartArgs(): string[] {
  return [
    "@openworkflow/cli",
    "worker",
    "start",
    "--concurrency",
    String(parseOpenWorkflowConcurrency(process.env.OPENWORKFLOW_CONCURRENCY)),
  ]
}
