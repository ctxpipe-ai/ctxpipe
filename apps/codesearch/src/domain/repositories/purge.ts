import { rm } from "node:fs/promises"
import { join } from "node:path"

import { REPO_CACHE_DIR } from "../../config/paths.js"
import { deleteRepositoryArtifacts, shardStore } from "../store/shardStore.js"
import { purgeZoektShardsForRepo } from "../zoekt/pinManager.js"
import { zoektRepositoryName } from "../zoekt/shardPrefix.js"

/**
 * Removes git checkout cache and Zoekt index shards for a repository, and
 * its artifacts in the shard store (fail-closed: an S3 error throws).
 * Hot symlinks/pin state and cold shard files are removed under one lock.
 */
export async function purgeRepositoryFromDisk(params: {
  orgId: string
  repoId: string
  repoName: string
  zoektRepoId: number
}): Promise<void> {
  const { orgId, repoId, zoektRepoId } = params

  // The S3 copies go first: a pin in between still finds the local shards
  // and fetches nothing, and a failed S3 delete fails the purge.
  const store = shardStore()
  if (store) await deleteRepositoryArtifacts(store, { orgId, repoId })

  const repoRoot = join(REPO_CACHE_DIR, orgId, repoId)
  await rm(repoRoot, { recursive: true, force: true })

  await purgeZoektShardsForRepo({
    zoektRepoId,
    zoektName: zoektRepositoryName({ orgId, repoId }),
  })
}
