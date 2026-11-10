import { PassThrough } from "node:stream"
import { parseArgs } from "node:util"

import {
  compareGraphSnapshots,
  fetchRdb,
  readGraphSnapshot,
} from "../../../../shared/falkordb-transfer.js"
import { REPO_CACHE_DIR, ZOEKT_INDEX_DIR } from "../config/paths.js"
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
 *   bun run cutover:export-indexes --to s3://<bucket>/<prefix>/<run-id> \
 *     --falkordb "$GRAPH_DB_URI"
 */

type Options = {
  to: string
  /** The source FalkorDB, `redis://user:password@host:port`. Without it, no RDB. */
  falkordb?: string
  zoektIndexDir: string
  repoCacheDir: string
  /** The multipart part size. Tests make it small. */
  partSize?: number
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
  const upload = { partSize: options.partSize }
  const [falkordb, zoektIndex, repoCache] = await Promise.all([
    options.falkordb
      ? exportGraphs(transfer, options.falkordb, upload)
      : Promise.resolve(null),
    // `.build` holds unfinished Zoekt builds. `.store` holds the local
    // manifest copies of another shard store; seed-shard-store writes new ones.
    archive(
      transfer,
      "zoekt-index.tar",
      options.zoektIndexDir,
      ["./.build", "./.store"],
      upload,
    ),
    archive(transfer, "repo-cache.tar", options.repoCacheDir, [], upload),
  ])
  const manifest: TransferManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    falkordb,
    zoektIndex,
    repoCache,
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
  upload: { partSize?: number },
): Promise<NonNullable<TransferManifest["falkordb"]>> {
  const start = Date.now()
  const before = await readGraphSnapshot(url)
  const rdb = await uploadStream(
    transfer,
    "falkordb.rdb",
    fetchRdb(url),
    upload,
  )
  const changed = compareGraphSnapshots(before, await readGraphSnapshot(url))
  if (changed.length > 0)
    throw new Error(
      `The graphs changed during the export (${changed.length} differences). Stop the writes, then export to a new run id.`,
    )
  log.info({ step: "codesearch.cutover.export.falkordb", bytes: rdb.size })
  return { ...before, rdb, ms: Date.now() - start }
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
    if (!values.to)
      throw new Error(
        "Usage: export-indexes --to s3://bucket/prefix/run-id [--falkordb redis://…] [--zoekt-index-dir …] [--repo-cache-dir …]",
      )
    const manifest = await exportIndexes({
      to: values.to,
      falkordb: values.falkordb,
      zoektIndexDir: values["zoekt-index-dir"],
      repoCacheDir: values["repo-cache-dir"],
    })
    return { ...manifestSummary(manifest), ms: manifest.ms }
  })
}
