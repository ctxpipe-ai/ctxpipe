import { lstat, mkdir, readlink, readdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { ZOEKT_HOT_DIR, ZOEKT_INDEX_DIR } from "../../config/paths.js"
import { isZoektShardBasenameForRepo } from "./shardPrefix.js"

/** Idle time after last pin before hot symlinks for a repo are removed. */
export const PIN_IDLE_TTL_MS = 5 * 60 * 1000

type PinEntry = {
  repoName: string
  timer: ReturnType<typeof setTimeout>
  /** Bumped on every pin so stale unload callbacks cannot clear a newer pin. */
  generation: number
}

const pins = new Map<number, PinEntry>()

/** Per-repo async mutex so pin/unpin/unload never interleave on the same id. */
const repoQueues = new Map<number, Promise<void>>()

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function withRepoLock<T>(
  zoektRepoId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = repoQueues.get(zoektRepoId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.catch(() => {}).then(() => gate)
  repoQueues.set(zoektRepoId, next)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (repoQueues.get(zoektRepoId) === next) {
      repoQueues.delete(zoektRepoId)
    }
  }
}

async function listColdBasenames(
  repoName: string,
  coldDir: string,
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(coldDir)
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return []
    throw error
  }
  return entries.filter((name) => isZoektShardBasenameForRepo(name, repoName))
}

async function ensureSymlink(hotPath: string, coldPath: string): Promise<void> {
  try {
    const st = await lstat(hotPath)
    if (!st.isSymbolicLink()) {
      throw new Error(
        `hot path is not a symlink (refusing to replace): ${hotPath}`,
      )
    }
    const current = await readlink(hotPath)
    if (current === coldPath) return
    await rm(hotPath, { force: true })
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) {
      throw error
    }
  }
  try {
    await symlink(coldPath, hotPath)
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      const st = await lstat(hotPath)
      if (st.isSymbolicLink() && (await readlink(hotPath)) === coldPath) {
        return
      }
    }
    throw error
  }
}

async function removeHotSymlinks(
  repoName: string,
  coldDir: string,
  hotDir: string,
): Promise<void> {
  const fromCold = await listColdBasenames(repoName, coldDir)
  let fromHot: string[] = []
  try {
    fromHot = (await readdir(hotDir)).filter((name) =>
      isZoektShardBasenameForRepo(name, repoName),
    )
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) throw error
  }
  const basenames = new Set([...fromCold, ...fromHot])
  for (const basename of basenames) {
    const hotPath = join(hotDir, basename)
    try {
      const st = await lstat(hotPath)
      if (st.isSymbolicLink()) {
        await rm(hotPath, { force: true })
      }
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) throw error
    }
  }
}

function armIdleTimer(
  zoektRepoId: number,
  repoName: string,
  generation: number,
  idleTtlMs: number,
  coldDir: string,
  hotDir: string,
): void {
  const existing = pins.get(zoektRepoId)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    void withRepoLock(zoektRepoId, async () => {
      const current = pins.get(zoektRepoId)
      if (!current || current.generation !== generation) return
      pins.delete(zoektRepoId)
      try {
        await removeHotSymlinks(repoName, coldDir, hotDir)
      } catch (error) {
        // Keep process alive; next pin/refresh can repair hot dir.
        console.error(
          `[zoekt-pin] failed to unload repo ${zoektRepoId}:`,
          error,
        )
      }
    })
  }, idleTtlMs)

  pins.set(zoektRepoId, { repoName, timer, generation })
}

export type PinResult = {
  zoektRepoId: number
  repoName: string
  /** Number of cold `.zoekt` shard files linked (excludes `.meta`). */
  shardCount: number
}

async function pinRepoLocked(
  repo: { zoektRepoId: number; repoName: string },
  coldDir: string,
  hotDir: string,
  idleTtlMs: number,
): Promise<PinResult> {
  const basenames = await listColdBasenames(repo.repoName, coldDir)
  for (const basename of basenames) {
    await ensureSymlink(join(hotDir, basename), join(coldDir, basename))
  }
  const previous = pins.get(repo.zoektRepoId)
  const generation = (previous?.generation ?? 0) + 1
  if (previous) clearTimeout(previous.timer)
  armIdleTimer(
    repo.zoektRepoId,
    repo.repoName,
    generation,
    idleTtlMs,
    coldDir,
    hotDir,
  )
  const shardCount = basenames.filter((name) => name.endsWith(".zoekt")).length
  return { zoektRepoId: repo.zoektRepoId, repoName: repo.repoName, shardCount }
}

/**
 * Ensure hot-dir symlinks exist for the repo's cold shards and reset the idle TTL.
 * Missing cold shards is a no-op for files (TTL still arms for the id).
 */
export async function pinRepos(
  repos: ReadonlyArray<{ zoektRepoId: number; repoName: string }>,
  options?: {
    coldDir?: string
    hotDir?: string
    idleTtlMs?: number
  },
): Promise<PinResult[]> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  const idleTtlMs = options?.idleTtlMs ?? PIN_IDLE_TTL_MS

  await mkdir(hotDir, { recursive: true })
  await mkdir(coldDir, { recursive: true })

  const results: PinResult[] = []
  for (const repo of repos) {
    results.push(
      await withRepoLock(repo.zoektRepoId, () =>
        pinRepoLocked(repo, coldDir, hotDir, idleTtlMs),
      ),
    )
  }
  return results
}

/**
 * Re-link hot symlinks for a repo that is currently pinned (e.g. after reindex).
 * No-op if the repo is not pinned.
 */
export async function refreshPinnedRepo(
  repo: { zoektRepoId: number; repoName: string },
  options?: { coldDir?: string; hotDir?: string; idleTtlMs?: number },
): Promise<void> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  const idleTtlMs = options?.idleTtlMs ?? PIN_IDLE_TTL_MS
  await mkdir(hotDir, { recursive: true })
  await mkdir(coldDir, { recursive: true })
  await withRepoLock(repo.zoektRepoId, async () => {
    if (!pins.has(repo.zoektRepoId)) return
    await pinRepoLocked(repo, coldDir, hotDir, idleTtlMs)
  })
}

/** Drop pin state and hot symlinks for a repo immediately (purge). */
export async function unpinRepo(
  repo: { zoektRepoId: number; repoName: string },
  options?: { coldDir?: string; hotDir?: string },
): Promise<void> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  await withRepoLock(repo.zoektRepoId, async () => {
    const existing = pins.get(repo.zoektRepoId)
    if (existing) {
      clearTimeout(existing.timer)
      pins.delete(repo.zoektRepoId)
    }
    await removeHotSymlinks(repo.repoName, coldDir, hotDir)
  })
}

export function isRepoPinned(zoektRepoId: number): boolean {
  return pins.has(zoektRepoId)
}

/** Test helper: clear timers and pin map without touching the filesystem. */
export function resetPinManagerForTests(): void {
  for (const entry of pins.values()) clearTimeout(entry.timer)
  pins.clear()
  repoQueues.clear()
}
