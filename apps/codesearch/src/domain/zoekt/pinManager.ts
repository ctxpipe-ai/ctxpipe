import { lstat, mkdir, readdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { ZOEKT_HOT_DIR, ZOEKT_INDEX_DIR } from "../../config/paths.js"
import { isZoektShardBasenameForRepo } from "./shardPrefix.js"

/** Idle time after last pin before hot symlinks for a repo are removed. */
export const PIN_IDLE_TTL_MS = 5 * 60 * 1000

type PinEntry = {
  repoName: string
  timer: ReturnType<typeof setTimeout>
}

const pins = new Map<number, PinEntry>()

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
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
    await rm(hotPath, { force: true })
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      // create below
    } else {
      throw error
    }
  }
  await symlink(coldPath, hotPath)
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
  idleTtlMs: number,
  coldDir: string,
  hotDir: string,
): void {
  const existing = pins.get(zoektRepoId)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    const current = pins.get(zoektRepoId)
    if (!current || current.timer !== timer) return
    pins.delete(zoektRepoId)
    void removeHotSymlinks(repoName, coldDir, hotDir)
  }, idleTtlMs)

  pins.set(zoektRepoId, { repoName, timer })
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
): Promise<void> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  const idleTtlMs = options?.idleTtlMs ?? PIN_IDLE_TTL_MS

  await mkdir(hotDir, { recursive: true })
  await mkdir(coldDir, { recursive: true })

  for (const repo of repos) {
    const basenames = await listColdBasenames(repo.repoName, coldDir)
    for (const basename of basenames) {
      await ensureSymlink(join(hotDir, basename), join(coldDir, basename))
    }
    armIdleTimer(repo.zoektRepoId, repo.repoName, idleTtlMs, coldDir, hotDir)
  }
}

/**
 * Re-link hot symlinks for a repo that is currently pinned (e.g. after reindex).
 * No-op if the repo is not pinned.
 */
export async function refreshPinnedRepo(
  repo: { zoektRepoId: number; repoName: string },
  options?: { coldDir?: string; hotDir?: string; idleTtlMs?: number },
): Promise<void> {
  if (!pins.has(repo.zoektRepoId)) return
  await pinRepos([repo], options)
}

/** Drop pin state and hot symlinks for a repo immediately (purge). */
export async function unpinRepo(
  repo: { zoektRepoId: number; repoName: string },
  options?: { coldDir?: string; hotDir?: string },
): Promise<void> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  const existing = pins.get(repo.zoektRepoId)
  if (existing) {
    clearTimeout(existing.timer)
    pins.delete(repo.zoektRepoId)
  }
  await removeHotSymlinks(repo.repoName, coldDir, hotDir)
}

export function isRepoPinned(zoektRepoId: number): boolean {
  return pins.has(zoektRepoId)
}

/** Test helper: clear timers and pin map without touching the filesystem. */
export function resetPinManagerForTests(): void {
  for (const entry of pins.values()) clearTimeout(entry.timer)
  pins.clear()
}
