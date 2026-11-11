import { basename } from "node:path"
import { PassThrough } from "node:stream"
import { parseArgs } from "node:util"

import {
  compareGraphSnapshots,
  fetchRdb,
  readGraphSnapshot,
} from "../../../../shared/falkordb-transfer.js"
import {
  REPO_CACHE_DIR,
  ZOEKT_INDEX_DIR,
  zoektStagingDirFromIndexDir,
  zoektStoreDirFromIndexDir,
} from "../config/paths.js"
import { log } from "../observability/logger.js"
import {
  manifestSummary,
  readTransferManifest,
  runCli,
  startTar,
  type Transfer,
  type TransferManifest,
  transferFromUrl,
  uploadStream,
  writeTransferManifest,
} from "./transfer.js"

/*
 * export-indexes (CTX-1217): in the Railway codesearch service, after the
 * writes stop. It copies the FalkorDB RDB and the codesearch volume to the
 * transfer prefix, and writes `manifest.json` last. The three copies run at
 * the same time.
 *
 *   bun run cutover:export-indexes --to s3://<bucket>/<prefix>/<run-id>
 *
 * It reads the source FalkorDB URL from GRAPH_DB_URI, so that the password
 * is not in the command line. `--falkordb` replaces it.
 */

type VolumeDirs = { zoektIndexDir: string; repoCacheDir: string }

type Options = VolumeDirs & {
  to: string
  /** The source FalkorDB, `redis://user:password@host:port`. */
  falkordb: string
}

export async function exportIndexes(
  options: Options,
): Promise<TransferManifest> {
  const transfer = transferFromUrl(options.to)
  if (await readTransferManifest(transfer))
    throw new Error(
      `${options.to} has a manifest already. Export to a new run id.`,
    )
  const start = Date.now()
  const [falkordb, volume] = await Promise.all([
    exportGraphs(transfer, options.falkordb),
    exportVolume(transfer, options),
  ])
  const manifest: TransferManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    falkordb,
    ...volume,
    ms: Date.now() - start,
  }
  await writeTransferManifest(transfer, manifest)
  return manifest
}

/**
 * The RDB, with the graph counts before it. The counts after it must be the
 * same: a difference means that a write came during the export.
 */
async function exportGraphs(
  transfer: Transfer,
  url: string,
): Promise<TransferManifest["falkordb"]> {
  const start = Date.now()
  const before = await readGraphSnapshot(url)
  const rdb = await uploadStream(transfer, "falkordb.rdb", fetchRdb(url))
  const changed = compareGraphSnapshots(before, await readGraphSnapshot(url))
  if (changed.length > 0)
    throw new Error(
      `The graphs changed during the export (${changed.length} differences). Stop the writes, then export to a new run id.`,
    )
  log.info({ step: "codesearch.cutover.export.falkordb", bytes: rdb.size })
  return { ...before, rdb, ms: Date.now() - start }
}

/**
 * The two archives of the codesearch volume. The cold Zoekt directory goes
 * without its staging directory (unfinished builds) and its store directory
 * (the local manifest copies of another shard store; seed-shard-store writes
 * new ones). Tests give a small multipart part size.
 */
export async function exportVolume(
  transfer: Transfer,
  dirs: VolumeDirs,
  upload: { partSize?: number } = {},
): Promise<Pick<TransferManifest, "zoektIndex" | "repoCache">> {
  const cold = dirs.zoektIndexDir
  const [zoektIndex, repoCache] = await Promise.all([
    archive(
      transfer,
      "zoekt-index.tar",
      cold,
      [zoektStagingDirFromIndexDir(cold), zoektStoreDirFromIndexDir(cold)].map(
        (dir) => `./${basename(dir)}`,
      ),
      upload,
    ),
    archive(transfer, "repo-cache.tar", dirs.repoCacheDir, [], upload),
  ])
  return { zoektIndex, repoCache }
}

/** A tar archive of `dir`, without the `excluded` members. */
async function archive(
  transfer: Transfer,
  key: string,
  dir: string,
  excluded: string[],
  upload: { partSize?: number },
): Promise<TransferManifest["zoektIndex"]> {
  const start = Date.now()
  const tar = startTar(
    [
      "-cvf",
      "-",
      "-C",
      dir,
      "--anchored",
      ...excluded.map((member) => `--exclude=${member}`),
      ".",
    ],
    "stderr",
  )
  tar.child.stdin.end()
  // Read the archive at once: when tar exits, Node drops the output that no
  // reader took yet.
  const output = tar.child.stdout.pipe(new PassThrough())
  const object = await uploadStream(transfer, key, output, upload).catch(
    (error: unknown) => {
      tar.child.kill()
      throw error
    },
  )
  const counts = await tar.done
  log.info({
    step: "codesearch.cutover.export.archive",
    key,
    bytes: object.size,
  })
  return { ...object, ...counts, ms: Date.now() - start }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      to: { type: "string" },
      falkordb: { type: "string" },
      "zoekt-index-dir": { type: "string", default: ZOEKT_INDEX_DIR },
      "repo-cache-dir": { type: "string", default: REPO_CACHE_DIR },
    },
  })
  runCli(async () => {
    const falkordb = values.falkordb ?? process.env["GRAPH_DB_URI"]
    if (!values.to || !falkordb)
      throw new Error(
        "Usage: GRAPH_DB_URI=redis://… export-indexes --to s3://bucket/prefix/run-id [--falkordb redis://…] [--zoekt-index-dir …] [--repo-cache-dir …]",
      )
    const manifest = await exportIndexes({
      to: values.to,
      falkordb,
      zoektIndexDir: values["zoekt-index-dir"],
      repoCacheDir: values["repo-cache-dir"],
    })
    return { ...manifestSummary(manifest), ms: manifest.ms }
  })
}
