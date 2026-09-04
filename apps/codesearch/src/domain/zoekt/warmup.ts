import { ZOEKT_WEBSERVER_URL } from "../../config/paths.js"

export class ZoektWarmupTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ZoektWarmupTimeoutError"
  }
}

/** Narrow fetch surface so tests can inject `vi.fn()` without `typeof fetch` friction. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<Response>

type ZoektListResponse = {
  List?: {
    Repos?: Array<{
      Repository?: { ID?: number }
    }>
  }
}

/** Single-shard baseline; organisation-wide searches scale up to the bounded maximum. */
export const ZOEKT_WARMUP_TIMEOUT_MS = 8_000
export const ZOEKT_WARMUP_MAX_TIMEOUT_MS = 20_000
const LIST_FETCH_TIMEOUT_MS = 2_000

/**
 * Loading one hot shard is normally quick, but Zoekt's directory watcher
 * processes larger cold-pin sets progressively. Give each additional shard a
 * bounded second instead of applying the single-repository timeout to every
 * organisation-wide search.
 */
export function zoektWarmupTimeoutMs(
  pinResults: ReadonlyArray<{ shardCount: number }>,
): number {
  const shardCount = pinResults.reduce(
    (total, result) => total + Math.max(0, result.shardCount),
    0,
  )
  return Math.min(
    ZOEKT_WARMUP_MAX_TIMEOUT_MS,
    ZOEKT_WARMUP_TIMEOUT_MS + Math.max(0, shardCount - 1) * 1_000,
  )
}

export async function listLoadedZoektRepoIds(
  baseUrl: string = ZOEKT_WEBSERVER_URL,
  fetchFn: FetchLike = fetch,
  fetchTimeoutMs: number = LIST_FETCH_TIMEOUT_MS,
): Promise<Set<number>> {
  const res = await fetchFn(`${baseUrl}/api/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(Math.max(1, fetchTimeoutMs)),
  })
  if (!res.ok) {
    throw new Error(`Zoekt list returned status ${res.status}`)
  }
  const data = (await res.json()) as ZoektListResponse
  const ids = new Set<number>()
  for (const entry of data.List?.Repos ?? []) {
    const id = entry.Repository?.ID
    if (typeof id === "number") ids.add(id)
  }
  return ids
}

/**
 * Poll Zoekt `/api/list` until every expected repo id is loaded, or timeout.
 * Call after pinning hot symlinks — Zoekt does not error on cold misses; it
 * returns empty search results with ShardsScanned=0.
 */
export async function waitUntilZoektReposLoaded(params: {
  repoIds: ReadonlyArray<number>
  baseUrl?: string
  timeoutMs?: number
  pollIntervalMs?: number
  fetchFn?: FetchLike
  sleepFn?: (ms: number) => Promise<void>
}): Promise<void> {
  const expected = [...new Set(params.repoIds)].filter((id) => id > 0)
  if (expected.length === 0) return

  const baseUrl = params.baseUrl ?? ZOEKT_WEBSERVER_URL
  const timeoutMs = params.timeoutMs ?? ZOEKT_WARMUP_TIMEOUT_MS
  const pollIntervalMs = params.pollIntervalMs ?? 100
  const fetchFn = params.fetchFn ?? fetch
  const sleepFn =
    params.sleepFn ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const loaded = await listLoadedZoektRepoIds(
        baseUrl,
        fetchFn,
        Math.min(LIST_FETCH_TIMEOUT_MS, remaining),
      )
      if (expected.every((id) => loaded.has(id))) return
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    const remainingAfter = deadline - Date.now()
    if (remainingAfter <= 0) break
    await sleepFn(Math.min(pollIntervalMs, remainingAfter))
  }

  const detail =
    lastError instanceof Error ? ` last error: ${lastError.message}` : ""
  throw new ZoektWarmupTimeoutError(
    `Zoekt did not load repo ids [${expected.join(", ")}] within ${timeoutMs}ms.${detail}`,
  )
}
