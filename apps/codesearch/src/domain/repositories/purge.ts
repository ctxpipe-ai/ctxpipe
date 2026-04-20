import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../../config/paths.js"

/**
 * Derive the shard filename prefix that `zoekt-index` produces from a repo name.
 * Zoekt replaces `/` with `_` in the `Name` metadata field to form the prefix.
 */
function shardPrefix(repoName: string): string {
  return `${repoName.replaceAll("/", "_")}_`
}

/**
 * Removes git checkout cache and Zoekt index shards for a repository.
 * Shard matching uses the repo-name prefix that `zoekt-index` embeds in
 * filenames (e.g. `owner_repo_v16.00000.zoekt`).
 */
export async function purgeRepositoryFromDisk(params: {
  orgId: string
  repoId: string
  repoName: string
  zoektRepoId: number
}): Promise<void> {
  const { orgId, repoId, repoName } = params

  const repoRoot = join(REPO_CACHE_DIR, orgId, repoId)
  await rm(repoRoot, { recursive: true, force: true })

  let entries: string[] = []
  try {
    entries = await readdir(ZOEKT_INDEX_DIR)
  } catch {
    return
  }

  const prefix = shardPrefix(repoName)
  for (const name of entries) {
    if (!name.endsWith(".zoekt") || !name.startsWith(prefix)) continue
    await rm(join(ZOEKT_INDEX_DIR, name), { force: true })
  }
}
