import { lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { ZOEKT_HOT_DIR, ZOEKT_INDEX_DIR } from "../../config/paths.js"
import { purgeZoektShardsForRepo } from "../zoekt/pinManager.js"
import {
  parseZoektShardBasename,
  zoektRepositoryName,
} from "../zoekt/shardPrefix.js"
import { repoCheckoutsDir, repoSharedClonePath } from "./paths.js"
import {
  pruneWorktrees,
  removeCheckoutWorktree,
  withSharedClone,
} from "./worktrees.js"

const SHA = "[0-9a-f]{40}(?:[0-9a-f]{24})?"

/**
 * The checkout keys that garbage collection can delete: an immutable source
 * revision (`rev:<sha>`), or a Workspace checkout (`ws:<id>:<sha>` and the
 * older `ws:<id>`), which no reader uses now. The `default` checkout and
 * other key shapes are never deleted. The pattern also keeps each key a
 * single safe path segment.
 */
export const COLLECTABLE_CHECKOUT_KEY = new RegExp(
  `^(?:rev:${SHA}|ws:[A-Za-z0-9_-]+(?::${SHA})?)$`,
)

/**
 * Deletes one checkout key of a repository from disk: the clone directory,
 * its `.scip` files, and its Zoekt shards (under the pin lock, so a search
 * cannot pin the shards again during the delete). A key that has no files
 * deletes nothing, so a second call is safe.
 */
export async function deleteCheckoutFromDisk(input: {
  orgId: string
  repoId: string
  checkoutKey: string
  zoektRepoId: number
}): Promise<void> {
  if (!COLLECTABLE_CHECKOUT_KEY.test(input.checkoutKey))
    throw new Error(`Checkout key cannot be collected: ${input.checkoutKey}`)
  const checkoutsDir = repoCheckoutsDir(input.orgId, input.repoId)
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
  const sharedPath = repoSharedClonePath(input.orgId, input.repoId)
  await withSharedClone(sharedPath, async () => {
    for (const path of paths)
      if (path.endsWith(".scip")) await rm(path, { force: true })
      else await removeCheckoutWorktree({ sharedPath, checkoutPath: path })
  })
  await purgeZoektShardsForRepo({ zoektRepoId: input.zoektRepoId, zoektName })
}

/** The checkout key of an entry in `checkouts/`: the name up to its first `.`. */
function checkoutKeyOfEntry(name: string): string {
  return name.split(".")[0] ?? name
}

async function entrySize(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  const names = await readdir(path).catch(() => [] as string[])
  let total = 0
  for (const name of names) total += await entrySize(join(path, name))
  return total
}

/**
 * Deletes the files of one repository that no checkout row names, so that
 * no reader can reach them: a checkout directory or `.scip` file of a key
 * with no row, a Zoekt shard of a key with no row, and a temporary file that
 * a stopped index build left. It keeps the published key and each key in
 * `rowKeys`, and each file that changed in the last `minAgeMs`. The caller
 * holds the purge operation of the repository, so no index build of it runs.
 * It gives the count and the size of what it deleted.
 */
export async function sweepRepositoryDisk(input: {
  orgId: string
  repoId: string
  rowKeys: ReadonlySet<string>
  publishedCheckoutKey: string
  minAgeMs: number
  now?: number
}): Promise<{ deletedEntries: number; deletedBytes: number }> {
  const now = input.now ?? Date.now()
  const result = { deletedEntries: 0, deletedBytes: 0 }
  const keep = (key: string) =>
    input.rowKeys.has(key) || key === input.publishedCheckoutKey
  const oldEnough = async (path: string) => {
    const info = await lstat(path).catch(() => null)
    return Boolean(info && now - info.mtimeMs >= input.minAgeMs)
  }
  const sharedPath = repoSharedClonePath(input.orgId, input.repoId)
  const checkoutsDir = repoCheckoutsDir(input.orgId, input.repoId)
  await withSharedClone(sharedPath, async () => {
    for (const name of await readdir(checkoutsDir).catch(
      () => [] as string[],
    )) {
      const path = join(checkoutsDir, name)
      const temporary = name.endsWith(".tmp")
      if (
        (!temporary && keep(checkoutKeyOfEntry(name))) ||
        !(await oldEnough(path))
      )
        continue
      const size = await entrySize(path)
      if (name.endsWith(".scip") || temporary) await rm(path, { force: true })
      else await removeCheckoutWorktree({ sharedPath, checkoutPath: path })
      result.deletedEntries += 1
      result.deletedBytes += size
    }
    await pruneWorktrees(sharedPath)
  })

  // Zoekt shards: `<name>_v16.00000.zoekt`, its `.meta`, and a stopped
  // build's `<shard>.<n>.tmp`. The name of a key is the base name of the
  // repository plus `:checkout:<key>`, or the base name for `default`.
  const base = zoektRepositoryName({ orgId: input.orgId, repoId: input.repoId })
  const basePrefix = encodeURIComponent(base)
  const shardKey = (fileName: string): string | null => {
    const parsed = parseZoektShardBasename(fileName)
    if (!parsed) return null
    const { zoektName: name, temporary } = parsed
    if (temporary)
      return name === base || name.startsWith(`${base}:checkout:`) ? "" : null
    if (name === base) return "default"
    return name.startsWith(`${base}:checkout:`)
      ? name.slice(`${base}:checkout:`.length)
      : null
  }
  for (const name of await readdir(ZOEKT_INDEX_DIR).catch(
    () => [] as string[],
  )) {
    if (!name.startsWith(basePrefix)) continue
    const key = shardKey(name)
    // "" is a temporary file of this repository: no row keeps it.
    if (key === null || (key !== "" && keep(key))) continue
    const path = join(ZOEKT_INDEX_DIR, name)
    if (!(await oldEnough(path))) continue
    const size = (await lstat(path).catch(() => null))?.size ?? 0
    await rm(join(ZOEKT_HOT_DIR, name), { force: true })
    await rm(path, { force: true })
    result.deletedEntries += 1
    result.deletedBytes += size
  }
  return result
}
