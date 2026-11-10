import { type ChildProcessByStdio, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { basename } from "node:path"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { z } from "zod"

import { s3Client } from "../domain/store/shardStore.js"
import { parseZoektShardBasename } from "../domain/zoekt/shardPrefix.js"
import { log } from "../observability/logger.js"

/*
 * The transfer prefix of the cutover index copy (CTX-1217): `export-indexes`
 * writes the FalkorDB RDB and the codesearch volume archives to
 * `s3://<bucket>/<prefix>/`, and `manifest.json` last. `import-indexes` and
 * `verify-graph` read them.
 */

export type Transfer = { client: S3Client; bucket: string; prefix: string }

/** The transfer of `s3://bucket/prefix`. The SDK default chain gives the credentials. */
export function transferFromUrl(url: string): Transfer {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.*[^/])\/?$/.exec(
    url,
  )
  if (!match?.[1] || !match[2])
    throw new Error("The transfer URL must have the form s3://bucket/prefix")
  return { client: s3Client(), bucket: match[1], prefix: `${match[2]}/` }
}

const objectSchema = z.object({
  key: z.string().regex(/^[\w.-]+$/),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

const archiveSchema = objectSchema.extend({
  /** The archived files and symlinks (no directories). */
  files: z.number().int().nonnegative(),
  ms: z.number(),
})

export const manifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  falkordb: z
    .object({
      redisVersion: z.string(),
      moduleVersion: z.number().int(),
      graphs: z.array(
        z.object({
          name: z.string(),
          nodes: z.number().int(),
          edges: z.number().int(),
        }),
      ),
      rdb: objectSchema,
      ms: z.number(),
    })
    .nullable(),
  zoektIndex: archiveSchema.extend({
    /** The `.zoekt` shard files (no `.meta` sidecars). */
    shards: z.number().int().nonnegative(),
  }),
  repoCache: archiveSchema,
  ms: z.number(),
})

export type TransferManifest = z.infer<typeof manifestSchema>
export type TransferObject = z.infer<typeof objectSchema>

/** The manifest of the transfer, or null when it has none. */
export async function readTransferManifest(
  transfer: Transfer,
): Promise<TransferManifest | null> {
  try {
    const response = await transfer.client.send(
      new GetObjectCommand({
        Bucket: transfer.bucket,
        Key: `${transfer.prefix}manifest.json`,
      }),
    )
    const text = (await response.Body?.transformToString()) ?? ""
    return manifestSchema.parse(JSON.parse(text))
  } catch (error) {
    if (error instanceof NoSuchKey) return null
    throw error
  }
}

/** Writes the manifest: the commit point of an export. */
export async function writeTransferManifest(
  transfer: Transfer,
  manifest: TransferManifest,
): Promise<void> {
  await transfer.client.send(
    new PutObjectCommand({
      Bucket: transfer.bucket,
      Key: `${transfer.prefix}manifest.json`,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    }),
  )
}

/**
 * Uploads a stream of unknown length as a multipart upload, with at most
 * `inFlight` parts at the same time, and gives its size and sha256. S3 takes
 * at most 10,000 parts, so a part of 64 MiB limits an object to 640 GiB.
 */
export async function uploadStream(
  transfer: Transfer,
  key: string,
  source: AsyncIterable<Uint8Array>,
  options: { partSize?: number; inFlight?: number } = {},
): Promise<TransferObject> {
  const partSize = options.partSize ?? 64 * 1024 * 1024
  const limit = options.inFlight ?? 2
  const target = { Bucket: transfer.bucket, Key: `${transfer.prefix}${key}` }
  const { UploadId } = await transfer.client.send(
    new CreateMultipartUploadCommand(target),
  )
  const hash = createHash("sha256")
  const parts: { PartNumber: number; ETag: string | undefined }[] = []
  const running = new Set<Promise<void>>()
  let failure: unknown
  let size = 0
  let pending: Buffer[] = []
  let pendingSize = 0
  const send = async (body: Buffer) => {
    const part = {
      PartNumber: parts.length + 1,
      ETag: undefined as string | undefined,
    }
    parts.push(part)
    const upload: Promise<void> = transfer.client
      .send(new UploadPartCommand({ ...target, UploadId, ...part, Body: body }))
      .then(
        (response) => {
          part.ETag = response.ETag
        },
        (error: unknown) => {
          failure ??= error
        },
      )
      .finally(() => running.delete(upload))
    running.add(upload)
    while (running.size >= limit) await Promise.race(running)
    if (failure) throw failure
  }
  try {
    for await (const chunk of source) {
      hash.update(chunk)
      size += chunk.length
      pending.push(Buffer.from(chunk))
      pendingSize += chunk.length
      while (pendingSize >= partSize) {
        const all = Buffer.concat(pending)
        pending = [all.subarray(partSize)]
        pendingSize = all.length - partSize
        await send(all.subarray(0, partSize))
      }
    }
    // A multipart upload needs at least one part.
    if (pendingSize > 0 || parts.length === 0)
      await send(Buffer.concat(pending))
    await Promise.all(running)
    if (failure) throw failure
    await transfer.client.send(
      new CompleteMultipartUploadCommand({
        ...target,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    )
  } catch (error) {
    await Promise.all(running)
    await transfer.client
      .send(new AbortMultipartUploadCommand({ ...target, UploadId }))
      .catch(() => undefined)
    throw error
  }
  return { key, size, sha256: hash.digest("hex") }
}

/**
 * Downloads an object into `write` and checks its size and sha256 against
 * `expected`. It throws on a difference, after `write` took all the bytes.
 */
export async function downloadChecked(
  transfer: Transfer,
  expected: TransferObject,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const response = await transfer.client.send(
    new GetObjectCommand({
      Bucket: transfer.bucket,
      Key: `${transfer.prefix}${expected.key}`,
    }),
  )
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    size += chunk.length
    await write(chunk)
  }
  const sha256 = hash.digest("hex")
  if (size !== expected.size || sha256 !== expected.sha256)
    throw new Error(
      `${expected.key} has ${size} bytes and sha256 ${sha256}, expected ${expected.size} bytes and ${expected.sha256}`,
    )
}

/**
 * Starts GNU tar with `-v` and counts the members that it lists: the files
 * and symlinks (a directory ends with `/`), and the `.zoekt` shards. With
 * `-f -`, tar lists them on stderr when it writes the archive, and on stdout
 * when it reads one. The names start with `./`. `done` fails when tar exits
 * with an error.
 */
export function startTar(
  args: string[],
  listing: "stdout" | "stderr",
): {
  child: ChildProcessByStdio<Writable, Readable, Readable>
  done: Promise<{ files: number; shards: number }>
} {
  const child = spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"] })
  // A tar that stops early closes its input. `done` reports why.
  child.stdin.on("error", () => undefined)
  const errors: string[] = []
  const counts = (async () => {
    let files = 0
    let shards = 0
    for await (const line of createInterface({ input: child[listing] }))
      if (!line.startsWith("./")) errors.push(line)
      else if (!line.endsWith("/")) {
        files++
        const shard = parseZoektShardBasename(basename(line))
        if (shard && !shard.temporary && line.endsWith(".zoekt")) shards++
      }
    return { files, shards }
  })()
  if (listing === "stdout")
    child.stderr.on("data", (chunk: Buffer) => errors.push(String(chunk)))
  const done = (async () => {
    const [code] = (await once(child, "close")) as [number | null]
    const result = await counts
    if (code !== 0)
      throw new Error(
        `tar ${args[0]} exited with ${code}: ${errors.join("\n").slice(-2000)}`,
      )
    return result
  })()
  // The caller awaits `done` after the stream that failed.
  done.catch(() => undefined)
  return { child, done }
}

/**
 * The counts and times of a manifest, without graph names: an operator can
 * paste it into the ticket.
 */
export function manifestSummary(manifest: TransferManifest) {
  const graph = manifest.falkordb
  return {
    falkordb: graph && {
      redisVersion: graph.redisVersion,
      moduleVersion: graph.moduleVersion,
      graphs: graph.graphs.length,
      nodes: graph.graphs.reduce((sum, item) => sum + item.nodes, 0),
      edges: graph.graphs.reduce((sum, item) => sum + item.edges, 0),
      bytes: graph.rdb.size,
      ms: graph.ms,
    },
    zoektIndex: {
      bytes: manifest.zoektIndex.size,
      files: manifest.zoektIndex.files,
      shards: manifest.zoektIndex.shards,
      ms: manifest.zoektIndex.ms,
    },
    repoCache: {
      bytes: manifest.repoCache.size,
      files: manifest.repoCache.files,
      ms: manifest.repoCache.ms,
    },
  }
}

/**
 * Runs a cutover tool: prints its JSON report to stdout, and exits 1 when
 * the report has `ok: false` or the tool throws.
 */
export function runCli(work: () => Promise<Record<string, unknown>>): void {
  work().then(
    (report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      process.exit(report["ok"] === false ? 1 : 0)
    },
    (error: unknown) => {
      log.error({
        step: "codesearch.cutover.failed",
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    },
  )
}
