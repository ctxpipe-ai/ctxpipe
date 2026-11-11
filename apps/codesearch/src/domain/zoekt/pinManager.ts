import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import {
  ZOEKT_HOT_DIR,
  ZOEKT_INDEX_DIR,
  zoektStagingDirFromIndexDir,
  zoektStoreDirFromIndexDir,
} from "../../config/paths.js"
import { log } from "../../observability/logger.js"
import { keyedMutex } from "../../utils/keyedMutex.js"
import { mapLimit } from "../../utils/mapLimit.js"
import {
  downloadArtifact,
  readManifest,
  shardStore,
  type StoreManifest,
} from "../store/shardStore.js"
import {
  isZoektShardBasenameForName,
  zoektRepositoryIdentity,
} from "./shardPrefix.js"

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

/**
 * Per-repo async mutex so pin, unpin, unload, install, fetch and eviction
 * never interleave on the same repo. The key is the Zoekt Name: each
 * checkout has one Name and one Zoekt id, and eviction knows only the Name.
 */
const repoLock = keyedMutex<string>()
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
    void withRepoLock(zoektName, async () => {
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
  let coldBasenames = await listDirBasenamesForRepo(repo.zoektName, coldDir)
  if (mode === "pin" && coldBasenames.length === 0) {
    coldBasenames = await fetchShardsLocked(repo.zoektName, coldDir)
  }
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

  // The mtime of the local manifest copy is the last pin time for eviction.
  const now = new Date()
  await utimes(localManifestPath(coldDir, repo.zoektName), now, now).catch(
    () => {},
  )

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
 * With a shard store set, and no cold shard of the name: downloads the
 * shards of the S3 manifest into a staging directory, moves them into cold,
 * and writes the local manifest copy. The caller holds the repo lock. A name
 * with no manifest gives no shards. An S3 error or a checksum difference
 * throws, and leaves no file in cold.
 */
async function fetchShardsLocked(
  zoektName: string,
  coldDir: string,
): Promise<string[]> {
  const store = shardStore()
  const identity = zoektRepositoryIdentity(zoektName)
  if (!store || !identity) return []
  const address = { ...identity, kind: "zoekt" as const }
  const manifest = await readManifest(store, address)
  if (!manifest) return []
  // A manifest names only shard files of this Name: no path can leave cold.
  for (const file of manifest.files)
    if (!isZoektShardBasenameForName(file.name, zoektName))
      throw new Error(`The S3 manifest names a foreign file: ${file.name}`)
  const startMs = Date.now()
  const stagingDir = join(zoektStagingDirFromIndexDir(coldDir), randomUUID())
  await mkdir(stagingDir, { recursive: true })
  try {
    await downloadArtifact(store, address, manifest, stagingDir)
    for (const file of manifest.files)
      await rename(join(stagingDir, file.name), join(coldDir, file.name))
  } catch (error) {
    // A move that stopped part way leaves no partial set of shards in cold.
    await removeColdEntries(zoektName, coldDir)
    throw error
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
  await writeLocalManifest(coldDir, zoektName, manifest)
  log.info({
    step: "codesearch.store.zoekt_fetched",
    fileCount: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    durationMs: Date.now() - startMs,
  })
  void evictColdShards({ coldDir })
  return manifest.files.map((file) => file.name)
}

/**
 * Ensure hot-dir symlinks exist for the repo's cold shards and reset the idle TTL.
 * With a shard store set, a repo with no cold shard fetches them first.
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

  // Each repo has its own lock; a limit keeps a search over many cold repos
  // from starting all of their fetches at once.
  return mapLimit(repos, 4, async (repo) => {
    // A repo with no cold shard can fetch: make room before the download,
    // outside its lock (eviction takes the locks of other names).
    if (
      shardStore() &&
      (await listDirBasenamesForRepo(repo.zoektName, coldDir)).length === 0
    )
      await evictColdShards({ coldDir })
    return withRepoLock(repo.zoektName, () =>
      pinRepoLocked(repo, coldDir, hotDir, idleTtlMs, "pin"),
    )
  })
}

/** Drop pin state and hot entries for a repo immediately. */
export async function unpinRepo(
  repo: ZoektRepo,
  options?: { coldDir?: string; hotDir?: string },
): Promise<void> {
  const hotDir = options?.hotDir ?? ZOEKT_HOT_DIR
  await withRepoLock(repo.zoektName, async () => {
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
  await withRepoLock(repo.zoektName, async () => {
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

/** The Zoekt Name of a local manifest copy file name, or null. */
function zoektNameOfLocalManifest(fileName: string): string | null {
  return fileName.endsWith(".json")
    ? decodeURIComponent(fileName.slice(0, -".json".length))
    : null
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
  return withRepoLock(repo.zoektName, async () => {
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
  repo: Pick<ZoektRepo, "zoektName">,
  manifest: StoreManifest,
  options?: { coldDir?: string },
): Promise<boolean> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  return withRepoLock(repo.zoektName, async () => {
    const cold = (await listDirBasenamesForRepo(repo.zoektName, coldDir)).sort()
    const uploaded = manifest.files.map((file) => file.name).sort()
    if (cold.join("\n") !== uploaded.join("\n")) return false
    await writeLocalManifest(coldDir, repo.zoektName, manifest)
    return true
  })
}

async function writeLocalManifest(
  coldDir: string,
  zoektName: string,
  manifest: StoreManifest,
): Promise<void> {
  const path = localManifestPath(coldDir, zoektName)
  await mkdir(zoektStoreDirFromIndexDir(coldDir), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(manifest))
  await rename(`${path}.tmp`, path)
}

/** Eviction starts when less than this share of the cold volume is free. */
const MIN_FREE_RATIO = 0.2

/** The eviction that runs now, for each cold directory. */
const evictions = new Map<string, Promise<number>>()

type EvictOptions = {
  coldDir?: string
  /** The free share of the cold volume (tests replace it). */
  freeRatio?: () => Promise<number>
}

/**
 * When less than 20% of the cold volume is free, deletes the cold shards of
 * the least recently pinned names until 20% is free again. It deletes only
 * names that have a local manifest copy (an S3 copy), that are not pinned,
 * and that no pin, fetch or upload touched in the last idle time (so a new
 * name is not deleted at once); a fetch on the next pin brings them back.
 * One eviction runs at a time for each cold directory. It gives the number
 * of names it evicted.
 */
export function evictColdShards(options?: EvictOptions): Promise<number> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const running = evictions.get(coldDir)
  if (running) return running
  const next = evict({ ...options, coldDir }).finally(() => {
    evictions.delete(coldDir)
  })
  evictions.set(coldDir, next)
  return next
}

async function evict(options?: EvictOptions): Promise<number> {
  const coldDir = options?.coldDir ?? ZOEKT_INDEX_DIR
  const freeRatio =
    options?.freeRatio ??
    (async () => {
      const fs = await statfs(coldDir)
      return fs.blocks > 0 ? fs.bavail / fs.blocks : 1
    })
  try {
    if ((await freeRatio()) >= MIN_FREE_RATIO) return 0
    const storeDir = zoektStoreDirFromIndexDir(coldDir)
    const names = (await readdir(storeDir).catch(() => [] as string[]))
      .map(zoektNameOfLocalManifest)
      .filter((name): name is string => name !== null)
    const byLastPin = await Promise.all(
      names.map(async (zoektName) => ({
        zoektName,
        mtimeMs:
          (await stat(localManifestPath(coldDir, zoektName)).catch(() => null))
            ?.mtimeMs ?? 0,
      })),
    )
    byLastPin.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const idleSince = Date.now() - PIN_IDLE_TTL_MS
    let evicted = 0
    for (const { zoektName, mtimeMs } of byLastPin) {
      if (mtimeMs > idleSince) break
      if ((await freeRatio()) >= MIN_FREE_RATIO) break
      const done = await withRepoLock(zoektName, async () => {
        const pinned = [...pins.values()].some(
          (entry) => entry.zoektName === zoektName,
        )
        if (pinned) return false
        // Read the copy again under the lock: a pin, fetch or upload since
        // the listing makes the name new again.
        const copy = localManifestPath(coldDir, zoektName)
        const current = await lstat(copy).catch(() => null)
        if (!current || current.mtimeMs > idleSince) return false
        await removeColdEntries(zoektName, coldDir)
        await rm(copy, { force: true })
        return true
      })
      if (done) evicted += 1
    }
    log.info({
      step: "codesearch.store.zoekt_evicted",
      evicted,
      freeRatio: await freeRatio(),
    })
    return evicted
  } catch (error) {
    log.error({
      step: "codesearch.store.zoekt_eviction_failed",
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
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
