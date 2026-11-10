import { once } from "node:events"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { finished } from "node:stream/promises"
import { parseArgs } from "node:util"

import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../config/paths.js"
import { log } from "../observability/logger.js"
import {
  downloadChecked,
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
 * the codesearch image with the codesearch volume and the FalkorDB data
 * volume mounted, while FalkorDB and codesearch are stopped. It checks the
 * sha256 of each object and the file and shard counts of the manifest.
 *
 *   bun run cutover:import-indexes --from s3://<bucket>/<prefix>/<run-id> \
 *     --falkordb-data-file /var/lib/falkordb/data/dump.rdb
 */

type Options = {
  from: string
  zoektIndexDir: string
  repoCacheDir: string
  /** Where FalkorDB reads its RDB at start. Necessary when the export has one. */
  falkordbDataFile?: string
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
  const dataFile = manifest.falkordb ? options.falkordbDataFile : undefined
  if (manifest.falkordb && !dataFile)
    throw new Error("The export has an RDB. Give --falkordb-data-file.")
  // Check each target before the first download.
  await emptyTarget(options.zoektIndexDir, options.force)
  await emptyTarget(options.repoCacheDir, options.force)
  if (dataFile) await freeDataFile(dataFile, options.force)
  const start = Date.now()
  const [falkordbMs, zoektIndex, repoCache] = await Promise.all([
    manifest.falkordb && dataFile
      ? writeDataFile(transfer, manifest.falkordb.rdb, dataFile)
      : Promise.resolve(null),
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
      falkordbMs,
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

/** Refuses an RDB that is there already, unless `force`. */
async function freeDataFile(path: string, force: boolean): Promise<void> {
  const size = await stat(path).then(
    (info) => info.size,
    () => 0,
  )
  if (size > 0 && !force)
    throw new Error(
      `${path} is there already. Delete it, or give --force to replace it.`,
    )
  await mkdir(dirname(path), { recursive: true })
}

/** Writes the RDB beside the data file, checks it, then renames it over the data file. */
async function writeDataFile(
  transfer: Transfer,
  rdb: TransferObject,
  path: string,
): Promise<number> {
  const start = Date.now()
  const temporary = `${path}.import`
  const file = createWriteStream(temporary)
  // `closed` also takes a write error, so that the error is not unhandled.
  const closed = finished(file)
  closed.catch(() => undefined)
  try {
    await downloadChecked(transfer, rdb, async (chunk) => {
      if (!file.write(chunk)) await Promise.race([once(file, "drain"), closed])
    })
    file.end()
    await closed
    await rename(temporary, path)
  } catch (error) {
    file.end()
    await closed.catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
  log.info({ step: "codesearch.cutover.import.falkordb", bytes: rdb.size })
  return Date.now() - start
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
    await downloadChecked(transfer, archive, async (chunk) => {
      if (!stdin.write(chunk))
        await Promise.race([once(stdin, "drain"), tar.done])
    })
  } catch (error) {
    stdin.destroy()
    await tar.done.catch(() => undefined)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. ${dir} holds a part of the archive: import again with --force.`,
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
      "falkordb-data-file": { type: "string" },
      "zoekt-index-dir": { type: "string", default: ZOEKT_INDEX_DIR },
      "repo-cache-dir": { type: "string", default: REPO_CACHE_DIR },
      force: { type: "boolean", default: false },
    },
  })
  runCli(async () => {
    if (!values.from)
      throw new Error(
        "Usage: import-indexes --from s3://bucket/prefix/run-id [--falkordb-data-file …] [--zoekt-index-dir …] [--repo-cache-dir …] [--force]",
      )
    return importIndexes({
      from: values.from,
      falkordbDataFile: values["falkordb-data-file"],
      zoektIndexDir: values["zoekt-index-dir"],
      repoCacheDir: values["repo-cache-dir"],
      force: values.force,
    })
  })
}
