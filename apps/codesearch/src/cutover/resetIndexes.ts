import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../config/paths.js"
import {
  deleteRepositoryArtifacts,
  writableShardStore,
} from "../domain/store/shardStore.js"
import {
  parseZoektShardBasename,
  zoektRepositoryIdentity,
} from "../domain/zoekt/shardPrefix.js"
import { errorKind, runCli } from "./transfer.js"

/*
 * reset-indexes (CTX-1217): the rollback of import-indexes and
 * seed-shard-store, on the AWS stateful host, while FalkorDB and codesearch
 * are stopped. After a rollback, AWS must keep no copy of the graphs and the
 * source code. For each repository that has a shard in the cold directory,
 * it deletes the artifacts of that repository in the shard store. Then it
 * deletes the contents of the cold directory and of the repository cache,
 * and the FalkorDB RDB. It deletes the store first, so that a second run
 * still finds the repositories when a delete fails. The report holds counts
 * only: a Zoekt Name holds organization and repository ids.
 *
 *   bun run cutover:reset-indexes --falkordb-data-file /var/lib/falkordb/data/dump.rdb
 */

export async function resetIndexes(options: {
  zoektIndexDir: string
  repoCacheDir: string
  falkordbDataFile: string
}) {
  const store = writableShardStore()
  if (!store)
    throw new Error(
      "CODESEARCH_SHARD_STORE is not set, or the store is read-only.",
    )
  const start = Date.now()
  try {
    return { ...(await reset(store, options)), ms: Date.now() - start }
  } catch (error) {
    // Only the kind: a path or an S3 key holds organization and repository ids.
    throw new Error(
      `The reset stopped (${errorKind(error)}). Run it again: it continues.`,
    )
  }
}

async function reset(
  store: NonNullable<ReturnType<typeof writableShardStore>>,
  options: Parameters<typeof resetIndexes>[0],
) {
  const repositories = new Map<string, { orgId: string; repoId: string }>()
  let unknown = 0
  for (const name of await entries(options.zoektIndexDir)) {
    const shard = parseZoektShardBasename(name)
    if (!shard) continue
    const identity = zoektRepositoryIdentity(shard.zoektName)
    if (!identity) {
      unknown += 1
      continue
    }
    repositories.set(`${identity.orgId}/${identity.repoId}`, identity)
  }
  for (const repository of repositories.values())
    await deleteRepositoryArtifacts(store, repository)
  const zoektIndexEntries = await empty(options.zoektIndexDir)
  const repoCacheEntries = await empty(options.repoCacheDir)
  await rm(options.falkordbDataFile, { force: true })
  return {
    ok: true,
    repositories: repositories.size,
    /** Shards of a Name with another form: they have no address in the store. */
    unknownShards: unknown,
    zoektIndexEntries,
    repoCacheEntries,
  }
}

async function entries(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}

/** Deletes the contents of `dir`, and keeps `dir`, which is a mount. */
async function empty(dir: string): Promise<number> {
  const names = await entries(dir)
  for (const name of names)
    await rm(join(dir, name), { recursive: true, force: true })
  return names.length
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "falkordb-data-file": { type: "string" },
      "zoekt-index-dir": { type: "string", default: ZOEKT_INDEX_DIR },
      "repo-cache-dir": { type: "string", default: REPO_CACHE_DIR },
    },
  })
  runCli(async () => {
    const dataFile = values["falkordb-data-file"]
    if (!dataFile)
      throw new Error(
        "Usage: reset-indexes --falkordb-data-file … [--zoekt-index-dir …] [--repo-cache-dir …]",
      )
    return resetIndexes({
      falkordbDataFile: dataFile,
      zoektIndexDir: values["zoekt-index-dir"],
      repoCacheDir: values["repo-cache-dir"],
    })
  })
}
