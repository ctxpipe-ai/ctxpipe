import { rm } from "node:fs/promises"
import { join } from "node:path"
import { REPO_CACHE_DIR } from "../../config/paths.js"
import { purgeZoektShardsForRepo } from "../zoekt/pinManager.js"

/**
 * Removes git checkout cache and Zoekt index shards for a repository.
 * Hot symlinks/pin state and cold shard files are removed under one lock.
 */
export async function purgeRepositoryFromDisk(params: {
  orgId: string
  repoId: string
  repoName: string
  zoektRepoId: number
}): Promise<void> {
  const { orgId, repoId, repoName, zoektRepoId } = params

  const repoRoot = join(REPO_CACHE_DIR, orgId, repoId)
  await rm(repoRoot, { recursive: true, force: true })

  await purgeZoektShardsForRepo({ zoektRepoId, repoName })
}
