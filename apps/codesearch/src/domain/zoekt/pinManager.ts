import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import {
  ZOEKT_HOT_DIR,
  ZOEKT_INDEX_DIR,
  zoektStoreDirFromIndexDir,
} from "../../config/paths.js"
import { log } from "../../observability/logger.js"
import { keyedMutex } from "../../utils/keyedMutex.js"
import type { StoreManifest } from "../store/shardStore.js"
import { isZoektShardBasenameForName } from "./shardPrefix.js"

/** A Zoekt repository: its id in the shards and its Name. */
export type ZoektRepo = { zoektRepoId: number; zoektName: string }

/** Idle time after last pin before hot symlinks for a repo are removed. */
const PIN_IDLE_TTL_MS = 5 * 60 * 1000

type PinEntry = {
  zoektName: string
  timer: ReturnType<typeof setTimeout>
  /** Bumped on every pin so stale unload callbacks cannot clear a newer pin. */
  generation: number
}

const pins = new Map<number, PinEntry>()

/** Per-repo async mutex so pin/unpin/unload never interleave on the same id. */
const repoLock = keyedMutex<number>()
const withRepoLock = repoLock.run

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function listDirBasenamesForRepo(
  zoektName: string,
  dir: string,
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return []
    throw error
  }
  return entries.filter((name) => isZoektShardBasenameForName(name, zoektName))
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
async function removeHotEntries(
  zoektName: string,
  hotDir: string,
): Promise<void> {
  const fromHot = await listDirBasenamesForRepo(zoektName, hotDir)
  for (const basename of fromHot) {
    await rm(join(hotDir, basename), { force: true })
  }
}

async function removeColdEntries(
  zoektName: string,
  coldDir: string,
): Promise<void> {
  const fromCold = await listDirBasenamesForRepo(zoektName, coldDir)
  for (const basename of fromCold) {
    await rm(join(coldDir, basename), { force: true })
  }
}

function armIdleTimer(
  zoektRepoId: number,
  zoektName: string,
  generation: number,
  idleTtlMs: number,
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
        await removeHotEntries(zoektName, hotDir)
      } catch (error) {
        log.error({
          step: "zoekt-pin.unload",
          zoektRepoId,
          zoektName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }, idleTtlMs)

  pins.set(zoektRepoId, { zoektName, timer, generation })
}

type PinResult = {
  zoektRepoId: number
  zoektName: string
  /** Number of cold `.zoekt` shard files linked (excludes `.meta`). */
  shardCount: number
}

async function pinRepoLocked(
  repo: ZoektRepo,
  coldDir: string,
  hotDir: string,
  idleTtlMs: number,
  mode: "pin" | "refresh",
): Promise<PinResult> {
  const coldBasenames = await listDirBasenamesForRepo(repo.zoektName, coldDir)
  const coldSet = new Set(coldBasenames)

  if (mode === "refresh") {
    const hotBasenames = await listDirBasenamesForRepo(repo.zoektName, hotDir)
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
  armIdleTimer(repo.zoektRepoId, repo.zoektName, generation, idleTtlMs, hotDir)
  const shardCount = coldBasenames.filter((name) =>
    name.endsWith(".zoekt"),
  ).length
  return {
    zoektRepoId: repo.zoektRepoId,
    zoektName: repo.zoektName,
    shardCount,
  }
}

/**
 * Ensure hot-dir symlinks exist for the repo's cold shards and reset the idle TTL.
 * Missing cold shards is a no-op for files (TTL still arms for the id).
 */
export async function pinRepos(
  repos: ReadonlyArray<ZoektRepo>,
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

/** Drop pin state and hot entries for a repo immediately. */
export async function unpinRepo(
  repo: ZoektRepo,
  options?: { coldDir?: string; hotDir?: string },
): Promise<void> {
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  await withRepoLock(repo.zoektRepoId, async () => {
    const existing = pins.get(repo.zoektRepoId)
    if (existing) {
      clearTimeout(existing.timer)
      pins.delete(repo.zoektRepoId)
    }
    await removeHotEntries(repo.zoektName, hotDir)
  })
}

/**
 * Under one per-repo lock: clear pin, remove hot entries, delete cold shards.
 * Prevents a concurrent search from re-pinning between unpin and cold delete.
 */
export async function purgeZoektShardsForRepo(
  repo: ZoektRepo,
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
    await removeHotEntries(repo.zoektName, hotDir)
    await rm(localManifestPath(coldDir, repo.zoektName), { force: true })
    await removeColdEntries(repo.zoektName, coldDir)
  })
}

/**
 * The local manifest copy of a Zoekt name: `<cold>/.store/<name>.json`. It
 * exists only while the cold shards of the name are the ones in the S3
 * manifest, so that eviction can delete them and fetch them again.
 */
export function localManifestPath(coldDir: string, zoektName: string): string {
  return join(
    zoektStoreDirFromIndexDir(coldDir),
    `${encodeURIComponent(zoektName)}.json`,
  )
}

/**
 * Under the repo lock: moves the shards that `zoekt-index` wrote to
 * `stagingDir` into cold, deletes the older cold shards of the name, and
 * refreshes the pin. It first deletes the local manifest copy, because the
 * new shards have no S3 copy yet. It returns the cold paths of the new shards.
 */
export async function installStagedShards(
  repo: ZoektRepo,
  stagingDir: string,
  options?: { coldDir?: string; hotDir?: string; idleTtlMs?: number },
): Promise<string[]> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  const idleTtlMs = options?.idleTtlMs ?? PIN_IDLE_TTL_MS
  await mkdir(hotDir, { recursive: true })
  await mkdir(coldDir, { recursive: true })
  return withRepoLock(repo.zoektRepoId, async () => {
    await rm(localManifestPath(coldDir, repo.zoektName), { force: true })
    const staged = await listDirBasenamesForRepo(repo.zoektName, stagingDir)
    // A rename over an older shard of the same name is atomic.
    for (const basename of staged)
      await rename(join(stagingDir, basename), join(coldDir, basename))
    const keep = new Set(staged)
    for (const basename of await listDirBasenamesForRepo(
      repo.zoektName,
      coldDir,
    ))
      if (!keep.has(basename))
        await rm(join(coldDir, basename), { force: true })
    if (pins.has(repo.zoektRepoId))
      await pinRepoLocked(repo, coldDir, hotDir, idleTtlMs, "refresh")
    return staged.map((basename) => join(coldDir, basename))
  })
}

/**
 * Under the repo lock: writes the local manifest copy after an upload, but
 * only when the cold shards of the name are still the files of the manifest.
 * It gives whether it wrote the copy.
 */
export async function markShardsUploaded(
  repo: ZoektRepo,
  manifest: StoreManifest,
  options?: { coldDir?: string },
): Promise<boolean> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  return withRepoLock(repo.zoektRepoId, async () => {
    const cold = (await listDirBasenamesForRepo(repo.zoektName, coldDir)).sort()
    const uploaded = manifest.files.map((file) => file.name).sort()
    if (cold.join("\n") !== uploaded.join("\n")) return false
    const path = localManifestPath(coldDir, repo.zoektName)
    await mkdir(zoektStoreDirFromIndexDir(coldDir), { recursive: true })
    await writeFile(`${path}.tmp`, JSON.stringify(manifest))
    await rename(`${path}.tmp`, path)
    return true
  })
}

export function isRepoPinned(zoektRepoId: number): boolean {
  return pins.has(zoektRepoId)
}

/** Test helper: clear timers and pin map without touching the filesystem. */
export function resetPinManagerForTests(): void {
  for (const entry of pins.values()) clearTimeout(entry.timer)
  pins.clear()
  repoLock.clear()
}
