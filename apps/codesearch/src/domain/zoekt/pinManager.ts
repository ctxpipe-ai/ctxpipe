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

async function listDirBasenamesForRepo(
  repoName: string,
  dir: string,
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return []
    throw error
  }
  return entries.filter((name) => isZoektShardBasenameForRepo(name, repoName))
}

/** Create or reuse an already-correct symlink (normal pin path). */
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

/**
 * Always recreate the symlink so its mtime changes and zoekt-webserver's
 * DirectoryWatcher reloads the shard after a cold-file replace.
 */
async function forceRecreateSymlink(
  hotPath: string,
  coldPath: string,
): Promise<void> {
  try {
    const st = await lstat(hotPath)
    if (!st.isSymbolicLink()) {
      throw new Error(
        `hot path is not a symlink (refusing to replace): ${hotPath}`,
      )
    }
    await rm(hotPath, { force: true })
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) {
      throw error
    }
  }
  await symlink(coldPath, hotPath)
}

/** Remove every hot-dir entry for the repo (symlink or stray file). */
async function removeHotEntries(repoName: string, hotDir: string): Promise<void> {
  const fromHot = await listDirBasenamesForRepo(repoName, hotDir)
  for (const basename of fromHot) {
    await rm(join(hotDir, basename), { force: true })
  }
}

async function removeColdEntries(
  repoName: string,
  coldDir: string,
): Promise<void> {
  const fromCold = await listDirBasenamesForRepo(repoName, coldDir)
  for (const basename of fromCold) {
    await rm(join(coldDir, basename), { force: true })
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
        await removeHotEntries(repoName, hotDir)
      } catch (error) {
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
  mode: "pin" | "refresh",
): Promise<PinResult> {
  const coldBasenames = await listDirBasenamesForRepo(repo.repoName, coldDir)
  const coldSet = new Set(coldBasenames)

  if (mode === "refresh") {
    const hotBasenames = await listDirBasenamesForRepo(repo.repoName, hotDir)
    for (const basename of hotBasenames) {
      if (!coldSet.has(basename)) {
        await rm(join(hotDir, basename), { force: true })
      }
    }
    for (const basename of coldBasenames) {
      await forceRecreateSymlink(
        join(hotDir, basename),
        join(coldDir, basename),
      )
    }
  } else {
    for (const basename of coldBasenames) {
      await ensureSymlink(join(hotDir, basename), join(coldDir, basename))
    }
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
  const shardCount = coldBasenames.filter((name) =>
    name.endsWith(".zoekt"),
  ).length
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
        pinRepoLocked(repo, coldDir, hotDir, idleTtlMs, "pin"),
      ),
    )
  }
  return results
}

/**
 * Re-link hot symlinks for a repo that is currently pinned (e.g. after reindex).
 * Drops stale hot entries, force-recreates symlinks (mtime bump for Zoekt),
 * and resets the idle TTL. No-op if the repo is not pinned.
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
    await pinRepoLocked(repo, coldDir, hotDir, idleTtlMs, "refresh")
  })
}

/** Drop pin state and hot entries for a repo immediately. */
export async function unpinRepo(
  repo: { zoektRepoId: number; repoName: string },
  options?: { coldDir?: string; hotDir?: string },
): Promise<void> {
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  await withRepoLock(repo.zoektRepoId, async () => {
    const existing = pins.get(repo.zoektRepoId)
    if (existing) {
      clearTimeout(existing.timer)
      pins.delete(repo.zoektRepoId)
    }
    await removeHotEntries(repo.repoName, hotDir)
  })
}

/**
 * Under one per-repo lock: clear pin, remove hot entries, delete cold shards.
 * Prevents a concurrent search from re-pinning between unpin and cold delete.
 */
export async function purgeZoektShardsForRepo(
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
    await removeHotEntries(repo.repoName, hotDir)
    await removeColdEntries(repo.repoName, coldDir)
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
