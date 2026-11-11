import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { ZOEKT_INDEX_DIR } from "../config/paths.js"
import {
  fileSha256,
  mapLimit,
  parseStoreManifest,
  publishArtifact,
  shardStore,
} from "../domain/store/shardStore.js"
import {
  localManifestPath,
  markShardsUploaded,
} from "../domain/zoekt/pinManager.js"
import {
  parseZoektShardBasename,
  zoektRepositoryIdentity,
} from "../domain/zoekt/shardPrefix.js"
import { log } from "../observability/logger.js"
import { errorMessage, runCli } from "./transfer.js"

/*
 * seed-shard-store (CTX-1217): on AWS, after import-indexes, before the
 * backend starts. It publishes the cold shards of each Zoekt Name to the
 * shard store that `CODESEARCH_SHARD_STORE` names, and writes the local
 * manifest copy, as the Zoekt phase does after an upload. A Name whose local
 * manifest copy matches its cold shards (each name, size and sha256) is
 * skipped, so a second run publishes only what the first did not. The logs
 * and the report hold no Zoekt Name: it has organization and repository ids.
 *
 *   bun run cutover:seed-shard-store
 */

export async function seedShardStore(options: { coldDir: string }) {
  const store = shardStore()
  if (!store) throw new Error("CODESEARCH_SHARD_STORE is not set.")
  const start = Date.now()
  const byName = new Map<string, string[]>()
  for (const entry of await readdir(options.coldDir, { withFileTypes: true })) {
    const shard = entry.isFile() ? parseZoektShardBasename(entry.name) : null
    if (!shard || shard.temporary) continue
    byName.set(shard.zoektName, [
      ...(byName.get(shard.zoektName) ?? []),
      entry.name,
    ])
  }
  const outcomes = await mapLimit(
    [...byName.entries()].map(([name, files], index) => ({
      name,
      files,
      index,
    })),
    8,
    async ({ name: zoektName, files, index }) => {
      const identity = zoektRepositoryIdentity(zoektName)
      if (!identity) {
        log.warn({ step: "codesearch.cutover.seed.unknown_name" })
        return "unknown" as const
      }
      if (await localCopyMatches(options.coldDir, zoektName, files))
        return "skipped" as const
      try {
        const manifest = await publishArtifact(
          store,
          { ...identity, kind: "zoekt" },
          files.map((name) => join(options.coldDir, name)),
        )
        // The lock id only orders the work of this process on one Name.
        const marked = await markShardsUploaded(
          { zoektRepoId: index + 1, zoektName },
          manifest,
          { coldDir: options.coldDir },
        )
        if (!marked)
          throw new Error("The cold shards changed during the upload")
        return "published" as const
      } catch (error) {
        log.error({
          step: "codesearch.cutover.seed.failed",
          // A store key holds the ids. "default" is not an id.
          error: errorMessage(error, [
            zoektName,
            identity.orgId,
            identity.repoId,
            identity.checkoutKey === "default" ? "" : identity.checkoutKey,
          ]),
        })
        return "failed" as const
      }
    },
  )
  const count = (outcome: (typeof outcomes)[number]) =>
    outcomes.filter((item) => item === outcome).length
  const shards = [...byName.values()]
    .flat()
    .filter((name) => name.endsWith(".zoekt")).length
  return {
    ok: count("failed") === 0 && count("unknown") === 0,
    names: byName.size,
    shards,
    published: count("published"),
    skipped: count("skipped"),
    /** Names of another form: no address in the store. */
    unknown: count("unknown"),
    failed: count("failed"),
    ms: Date.now() - start,
  }
}

/**
 * True when the local manifest copy lists the cold files, with their sizes
 * and their sha256.
 */
async function localCopyMatches(
  coldDir: string,
  zoektName: string,
  files: string[],
): Promise<boolean> {
  try {
    const copy = parseStoreManifest(
      await readFile(localManifestPath(coldDir, zoektName), "utf8"),
    )
    if (copy.files.length !== files.length) return false
    for (const file of copy.files) {
      if (!files.includes(file.name)) return false
      const path = join(coldDir, file.name)
      if ((await stat(path)).size !== file.size) return false
      if ((await fileSha256(path)) !== file.sha256) return false
    }
    return true
  } catch {
    return false
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "zoekt-index-dir": { type: "string", default: ZOEKT_INDEX_DIR },
    },
  })
  runCli(() => seedShardStore({ coldDir: values["zoekt-index-dir"] }))
}
