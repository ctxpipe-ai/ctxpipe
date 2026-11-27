import { basename } from "node:path"
import { PassThrough } from "node:stream"
import { parseArgs } from "node:util"

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
 * writes stop. It copies the codesearch volume to the transfer prefix, and
 * writes `manifest.json` last. The two copies run at the same time.
 *
 *   bun run cutover:export-indexes --to s3://<bucket>/<prefix>/<run-id>
 */

type VolumeDirs = { zoektIndexDir: string; repoCacheDir: string }

type Options = VolumeDirs & {
  to: string
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
  const volume = await exportVolume(transfer, options)
  const manifest: TransferManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    ...volume,
    ms: Date.now() - start,
  }
  await writeTransferManifest(transfer, manifest)
  return manifest
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
      "zoekt-index-dir": { type: "string", default: ZOEKT_INDEX_DIR },
      "repo-cache-dir": { type: "string", default: REPO_CACHE_DIR },
    },
  })
  runCli(async () => {
    if (!values.to)
      throw new Error(
        "Usage: export-indexes --to s3://bucket/prefix/run-id [--zoekt-index-dir …] [--repo-cache-dir …]",
      )
    const manifest = await exportIndexes({
      to: values.to,
      zoektIndexDir: values["zoekt-index-dir"],
      repoCacheDir: values["repo-cache-dir"],
    })
    return { ...manifestSummary(manifest), ms: manifest.ms }
  })
}
