import { rm } from "node:fs/promises"

/*
 * The scratch folders that one worker process keeps for an ingestion run: the
 * copies of the source tree and the context index repositories (ADR-052
 * section 7). The holder deletes its folder when it ends. A holder that parks
 * and resumes on another worker, or that loses its run (a stale execution),
 * does not come back to this worker. So each new hold first deletes each
 * folder that no one used for an hour. A holder that comes back after that
 * makes its folder again. A shard step takes at most 10 minutes, so a
 * folder that a running step uses is never idle for an hour.
 */

const IDLE_MS = 60 * 60 * 1000

type Held = { value: Promise<{ dir: string }>; used: number }

const held = new Map<string, Held>()

/** The scratch value of `key`; `make` runs only when this process has none. */
export function holdScratch<T extends { dir: string }>(
  key: string,
  make: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  let entry = held.get(key)
  if (!entry) {
    for (const [other, idle] of held)
      if (now - idle.used > IDLE_MS) void drop(other)
    const value = make()
    const created: Held = { value, used: now }
    // A failed make is not kept, so a retry makes the folder again.
    value.catch(() => {
      if (held.get(key) === created) held.delete(key)
    })
    held.set(key, created)
    entry = created
  }
  entry.used = now
  return entry.value as Promise<T>
}

async function drop(key: string): Promise<void> {
  const entry = held.get(key)
  held.delete(key)
  const value = await entry?.value.catch(() => undefined)
  if (value) await rm(value.dir, { recursive: true, force: true })
}

/**
 * Delete the held folder of `key`. A key that ends with `:` is a prefix: each
 * folder whose key starts with it goes.
 */
export async function releaseScratch(key: string): Promise<void> {
  await Promise.all(
    [...held.keys()]
      .filter((k) => k === key || (key.endsWith(":") && k.startsWith(key)))
      .map(drop),
  )
}

/** The number of held folders whose key starts with `prefix` (for tests). */
export function heldScratch(prefix: string): number {
  return [...held.keys()].filter((key) => key.startsWith(prefix)).length
}
