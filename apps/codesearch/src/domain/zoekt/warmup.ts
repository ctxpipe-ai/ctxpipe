import { ZOEKT_WEBSERVER_URL } from "../../config/paths.js"

export class ZoektWarmupTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ZoektWarmupTimeoutError"
  }
}

type ZoektListResponse = {
  List?: {
    Repos?: Array<{
      Repository?: { ID?: number }
    }>
  }
}

export async function listLoadedZoektRepoIds(
  baseUrl: string = ZOEKT_WEBSERVER_URL,
  fetchFn: typeof fetch = fetch,
): Promise<Set<number>> {
  const res = await fetchFn(`${baseUrl}/api/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
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
  fetchFn?: typeof fetch
  sleepFn?: (ms: number) => Promise<void>
}): Promise<void> {
  const expected = [...new Set(params.repoIds)].filter((id) => id > 0)
  if (expected.length === 0) return

  const baseUrl = params.baseUrl ?? ZOEKT_WEBSERVER_URL
  const timeoutMs = params.timeoutMs ?? 30_000
  const pollIntervalMs = params.pollIntervalMs ?? 100
  const fetchFn = params.fetchFn ?? fetch
  const sleepFn =
    params.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const loaded = await listLoadedZoektRepoIds(baseUrl, fetchFn)
      if (expected.every((id) => loaded.has(id))) return
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await sleepFn(pollIntervalMs)
  }

  const detail =
    lastError instanceof Error ? ` last error: ${lastError.message}` : ""
  throw new ZoektWarmupTimeoutError(
    `Zoekt did not load repo ids [${expected.join(", ")}] within ${timeoutMs}ms.${detail}`,
  )
}
