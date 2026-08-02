import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../../config/paths.js"
import { isZoektShardBasenameForRepo } from "../zoekt/shardPrefix.js"

/**
 * Removes git checkout cache and Zoekt index shards for a repository.
 * Shard matching uses the repo-name prefix that `zoekt-index` embeds in
 * filenames (e.g. `owner%2Frepo_v16.00000.zoekt`).
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

  for (const name of entries) {
    if (!isZoektShardBasenameForRepo(name, repoName)) continue
    await rm(join(ZOEKT_INDEX_DIR, name), { force: true })
  }
}
