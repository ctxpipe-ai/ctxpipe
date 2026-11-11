import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { log } from "../../observability/logger.js"
import { keyedMutex } from "../../utils/keyedMutex.js"
import {
  downloadArtifact,
  publishArtifact,
  readManifest,
  shardStore,
} from "./shardStore.js"

type Checkout = { orgId: string; repoId: string; checkoutKey: string }

/** One merge write, upload or fetch at a time for each merged SCIP file. */
const scipLock = keyedMutex<string>()

/**
 * Runs `fn` under the lock of one merged SCIP file. The merge holds it from
 * its local write through its upload, so a fetch of an older index cannot
 * replace the new file or come back after the merge removed it.
 */
export function withScipLock<T>(
  scipPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return scipLock.run(scipPath, fn)
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/**
 * Uploads the merged SCIP index of a checkout to the shard store, or
 * an empty manifest when the merge wrote no file, so a reader never gets an
 * older index. The caller holds `withScipLock`. A failure does not fail the
 * merge: it is logged, and the next merge uploads again.
 */
export async function uploadScipIndex(
  checkout: Checkout,
  scipPath: string,
): Promise<void> {
  const store = shardStore()
  if (!store) return
  const startMs = Date.now()
  try {
    const paths = (await exists(scipPath)) ? [scipPath] : []
    await publishArtifact(store, { ...checkout, kind: "scip" }, paths)
    log.info({
      step: "codesearch.store.scip_uploaded",
      durationMs: Date.now() - startMs,
    })
  } catch (error) {
    log.warn({
      step: "codesearch.store.scip_upload_failed",
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * When the merged SCIP index of a checkout is not on disk and a shard store
 * is set, fetches it from S3 (a preview, or a disk after a host loss). A
 * missing manifest or a fetch error leaves it missing: the graph tools then
 * report no index, as before. The file moves into place in one rename.
 */
export async function ensureScipIndex(
  checkout: Checkout,
  scipPath: string,
  options?: { timeoutMs?: number },
): Promise<void> {
  const store = shardStore()
  if (!store || (await exists(scipPath))) return
  const fetching = fetchScipIndex(store, checkout, scipPath)
  // A graph read waits at most as long as a search does for Zoekt shards (a
  // merge can hold the lock, or the file can be large). Then it answers with
  // no index, and the fetch continues for the next read.
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    fetching,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options?.timeoutMs ?? 8_000)
    }),
  ])
  clearTimeout(timer)
}

async function fetchScipIndex(
  store: NonNullable<ReturnType<typeof shardStore>>,
  checkout: Checkout,
  scipPath: string,
): Promise<void> {
  try {
    await scipLock.run(scipPath, async () => {
      if (await exists(scipPath)) return
      const address = { ...checkout, kind: "scip" as const }
      const manifest = await readManifest(store, address)
      const file = manifest?.files[0]
      if (!manifest || !file) return
      if (manifest.files.length !== 1 || file.name !== basename(scipPath))
        throw new Error(`The S3 manifest names a foreign file: ${file.name}`)
      // A `.tmp` name, so the checkout sweep deletes what a crash leaves.
      const stagingDir = `${scipPath}.${randomUUID()}.tmp`
      await mkdir(stagingDir, { recursive: true })
      try {
        await downloadArtifact(store, address, manifest, stagingDir)
        await mkdir(dirname(scipPath), { recursive: true })
        await rename(join(stagingDir, file.name), scipPath)
      } finally {
        await rm(stagingDir, { recursive: true, force: true })
      }
    })
  } catch (error) {
    log.warn({
      step: "codesearch.store.scip_fetch_failed",
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
