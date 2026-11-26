import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../config/paths.js"
import { log } from "../observability/logger.js"
import {
  downloadChecked,
  errorMessage,
  manifestSummary,
  readTransferManifest,
  runCli,
  startTar,
  type Transfer,
  type TransferObject,
  transferFromUrl,
} from "./transfer.js"

/*
 * import-indexes (CTX-1217): on the AWS stateful host, as a one-off task of
 * the codesearch image with the codesearch volume mounted, while codesearch
 * is stopped. It checks the sha256 of each object and the file and shard
 * counts of the manifest.
 *
 *   bun run cutover:import-indexes --from s3://<bucket>/<prefix>/<run-id>
 */

type Options = {
  from: string
  zoektIndexDir: string
  repoCacheDir: string
  /** Deletes the contents of a target that is not empty. */
  force: boolean
}

export async function importIndexes(options: Options) {
  const transfer = transferFromUrl(options.from)
  const manifest = await readTransferManifest(transfer)
  if (!manifest)
    throw new Error(
      `${options.from} has no manifest: the export did not finish.`,
    )
  // Check each target before the first download.
  await emptyTarget(options.zoektIndexDir, options.force)
  await emptyTarget(options.repoCacheDir, options.force)
  const start = Date.now()
  const [zoektIndex, repoCache] = await Promise.all([
    extract(transfer, manifest.zoektIndex, options.zoektIndexDir),
    extract(transfer, manifest.repoCache, options.repoCacheDir),
  ])
  const problems: string[] = []
  if (zoektIndex.files !== manifest.zoektIndex.files)
    problems.push(
      `zoekt-index has ${zoektIndex.files} files, expected ${manifest.zoektIndex.files}`,
    )
  if (zoektIndex.shards !== manifest.zoektIndex.shards)
    problems.push(
      `zoekt-index has ${zoektIndex.shards} shards, expected ${manifest.zoektIndex.shards}`,
    )
  if (repoCache.files !== manifest.repoCache.files)
    problems.push(
      `repo-cache has ${repoCache.files} files, expected ${manifest.repoCache.files}`,
    )
  return {
    ok: problems.length === 0,
    problems,
    export: manifestSummary(manifest),
    import: {
      zoektIndexMs: zoektIndex.ms,
      repoCacheMs: repoCache.ms,
      ms: Date.now() - start,
    },
  }
}

/** Makes `dir`, or refuses a directory with entries unless `force` deletes them. */
async function emptyTarget(dir: string, force: boolean): Promise<void> {
  await mkdir(dir, { recursive: true })
  const names = await readdir(dir)
  if (names.length === 0) return
  if (!force)
    throw new Error(
      `${dir} is not empty (${names.length} entries). Empty it, or give --force to delete its contents.`,
    )
  for (const name of names)
    await rm(join(dir, name), { recursive: true, force: true })
}

/** Extracts an archive into `dir`, and counts its files and shards. */
async function extract(
  transfer: Transfer,
  archive: TransferObject,
  dir: string,
) {
  const start = Date.now()
  const tar = startTar(["-xvf", "-", "-C", dir], "stdout")
  const stdin = tar.child.stdin
  try {
    await downloadChecked(transfer, archive, stdin, tar.done)
  } catch (error) {
    stdin.destroy()
    await tar.done.catch(() => undefined)
    throw new Error(
      `${errorMessage(error)}. ${dir} holds a part of the archive: import again with --force.`,
    )
  }
  stdin.end()
  const counts = await tar.done
  log.info({
    step: "codesearch.cutover.import.archive",
    key: archive.key,
    files: counts.files,
  })
  return { ...counts, ms: Date.now() - start }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      "zoekt-index-dir": { type: "string", default: ZOEKT_INDEX_DIR },
      "repo-cache-dir": { type: "string", default: REPO_CACHE_DIR },
      force: { type: "boolean", default: false },
    },
  })
  runCli(async () => {
    if (!values.from)
      throw new Error(
        "Usage: import-indexes --from s3://bucket/prefix/run-id [--zoekt-index-dir …] [--repo-cache-dir …] [--force]",
      )
    return importIndexes({
      from: values.from,
      zoektIndexDir: values["zoekt-index-dir"],
      repoCacheDir: values["repo-cache-dir"],
      force: values.force,
    })
  })
}
