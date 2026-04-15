import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../../config/paths.js"

/**
 * Removes git checkout cache and Zoekt index shards for a repository.
 * Zoekt writes `*.zoekt` shards; we delete any shard whose name contains the
 * numeric `zoektRepoId` (matches per-repo indexing).
 */
export async function purgeRepositoryFromDisk(params: {
  orgId: string
  repoId: string
  zoektRepoId: number
}): Promise<void> {
  const { orgId, repoId, zoektRepoId } = params
  const needle = String(zoektRepoId)

  const repoRoot = join(REPO_CACHE_DIR, orgId, repoId)
  await rm(repoRoot, { recursive: true, force: true })

  let entries: string[] = []
  try {
    entries = await readdir(ZOEKT_INDEX_DIR)
  } catch {
    return
  }

  for (const name of entries) {
    if (!name.includes(needle) || !name.includes(".zoekt")) continue
    await rm(join(ZOEKT_INDEX_DIR, name), { force: true })
  }
}
