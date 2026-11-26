/**
 * The caches and temp files of the SCIP indexers, in one directory on the
 * data volume (`INDEXER_CACHE_DIR`).
 *
 * - Go, npm and XDG keep their caches there across runs.
 * - Each indexer run gets its own temp directory in `runs/<uuid>`, which is
 *   removed when the run ends.
 * - When a SCIP indexer slot starts above the size bound, the cache is emptied.
 *   Only one SCIP indexer runs at a time, so no run uses the cache then.
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Remove a tree. A Go module cache keeps its files and directories
 * read-only, so a process that is not root must make them writable first.
 */
async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EACCES" && code !== "EPERM") throw error
    await execFileAsync("chmod", ["-R", "u+w", path])
    await rm(path, { recursive: true, force: true })
  }
}

/** Run `fn` with a new, empty temp directory; remove it when `fn` ends. */
export async function withIndexerRunDir<T>(
  cacheDir: string,
  fn: (runDir: string) => Promise<T>,
): Promise<T> {
  const runDir = join(cacheDir, "runs", randomUUID())
  await mkdir(runDir, { recursive: true })
  try {
    return await fn(runDir)
  } finally {
    await removeTree(runDir)
  }
}

/** At startup: remove the run directories that a crash left behind. */
export async function removeIndexerRunDirs(cacheDir: string): Promise<void> {
  await removeTree(join(cacheDir, "runs"))
}

/**
 * Empty the cache when its size is above `maxBytes`. Call this only when no
 * indexer runs.
 */
export async function boundIndexerCache(
  cacheDir: string,
  maxBytes: number,
): Promise<{ bytes: number; emptied: boolean }> {
  await mkdir(cacheDir, { recursive: true })
  // `du` is much faster than a walk in JavaScript over a large module cache.
  const { stdout } = await execFileAsync("du", ["-sk", cacheDir])
  const bytes = Number.parseInt(stdout, 10) * 1024
  if (bytes <= maxBytes) return { bytes, emptied: false }
  for (const entry of await readdir(cacheDir)) {
    await removeTree(join(cacheDir, entry))
  }
  return { bytes, emptied: true }
}
