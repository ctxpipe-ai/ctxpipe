import { lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../../config/paths.js"
import { purgeZoektShardsForRepo } from "../zoekt/pinManager.js"
import {
  isZoektShardBasenameForName,
  zoektRepositoryName,
} from "../zoekt/shardPrefix.js"

const SHA = "[0-9a-f]{40}(?:[0-9a-f]{24})?"

/**
 * The checkout keys that garbage collection can delete: an immutable source
 * revision (`rev:<sha>`) or a Workspace projection (`ws:<id>:<sha>`). The
 * `default` checkout and other key shapes are never deleted. The pattern also
 * keeps each key a single safe path segment.
 */
export const COLLECTABLE_CHECKOUT_KEY = new RegExp(
  `^(?:rev:${SHA}|ws:[A-Za-z0-9_-]+:${SHA})$`,
)

/** Total bytes of the files in a tree. A symlink counts as itself. */
async function sizeOnDisk(path: string): Promise<number> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(path)
  } catch {
    return 0
  }
  if (!stats.isDirectory()) return stats.size
  let total = 0
  for (const name of await readdir(path).catch(() => [] as string[]))
    total += await sizeOnDisk(join(path, name))
  return total
}

/**
 * Deletes one checkout key of a repository from disk: the clone directory,
 * its `.scip` files, and its Zoekt shards (under the pin lock, so a search
 * cannot pin the shards again during the delete). Gives the bytes freed.
 * A key that has no files gives 0, so a second call is safe.
 */
export async function deleteCheckoutFromDisk(input: {
  orgId: string
  repoId: string
  checkoutKey: string
  zoektRepoId: number
}): Promise<number> {
  if (!COLLECTABLE_CHECKOUT_KEY.test(input.checkoutKey))
    throw new Error(`Checkout key cannot be collected: ${input.checkoutKey}`)
  const checkoutsDir = join(
    REPO_CACHE_DIR,
    input.orgId,
    input.repoId,
    "checkouts",
  )
  const names = await readdir(checkoutsDir).catch(() => [] as string[])
  const paths = names
    .filter(
      (name) =>
        name === input.checkoutKey ||
        (name.startsWith(`${input.checkoutKey}.`) && name.endsWith(".scip")),
    )
    .map((name) => join(checkoutsDir, name))
  const zoektName = zoektRepositoryName({
    orgId: input.orgId,
    repoId: input.repoId,
    checkoutKey: input.checkoutKey,
  })
  const shards = (await readdir(ZOEKT_INDEX_DIR).catch(() => [] as string[]))
    .filter((name) => isZoektShardBasenameForName(name, zoektName))
    .map((name) => join(ZOEKT_INDEX_DIR, name))
  let bytes = 0
  for (const path of [...paths, ...shards]) bytes += await sizeOnDisk(path)
  for (const path of paths) await rm(path, { recursive: true, force: true })
  await purgeZoektShardsForRepo({ zoektRepoId: input.zoektRepoId, zoektName })
  return bytes
}
