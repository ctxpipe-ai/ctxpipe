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

import { parseS3Url, s3Client } from "../domain/store/shardStore.js"
import { parseZoektShardBasename } from "../domain/zoekt/shardPrefix.js"
import { flushEvlog, initEvlog, log } from "../observability/logger.js"

/*
 * The transfer prefix of the cutover index copy (CTX-1217): `export-indexes`
 * writes the FalkorDB RDB and the codesearch volume archives to
 * `s3://<bucket>/<prefix>/`, and `manifest.json` last. `import-indexes` and
 * `verify-graph` read them.
 */

export type Transfer = { client: S3Client; bucket: string; prefix: string }

/** The transfer of `s3://bucket/prefix`. The SDK default chain gives the credentials. */
export function transferFromUrl(url: string): Transfer {
  const location = parseS3Url(url)
  if (!location?.prefix)
    throw new Error("The transfer URL must have the form s3://bucket/prefix")
  return {
    client: s3Client(),
    bucket: location.bucket,
    prefix: `${location.prefix}/`,
  }
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

const manifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  falkordb: z.object({
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
  }),
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
 * Uploads a stream of unknown length as a multipart upload, with at most 2
 * parts at the same time, and gives its size and sha256. S3 takes at most
 * 10,000 parts, so a part of 64 MiB limits an object to 640 GiB.
 */
export async function uploadStream(
  transfer: Transfer,
  key: string,
  source: AsyncIterable<Uint8Array>,
  options: { partSize?: number } = {},
): Promise<TransferObject> {
  const partSize = options.partSize ?? 64 * 1024 * 1024
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
    while (running.size >= 2) await Promise.race(running)
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
 * Downloads an object into `target` and checks its size and sha256 against
 * `expected`. It throws on a difference, after `target` took all the bytes.
 * When `target` is full, it waits for a drain. It throws when `stopped` (the
 * end of the process or of the file that `target` writes) comes first.
 */
export async function downloadChecked(
  transfer: Transfer,
  expected: TransferObject,
  target: Writable,
  stopped: Promise<unknown>,
): Promise<void> {
  const response = await transfer.client.send(
    new GetObjectCommand({
      Bucket: transfer.bucket,
      Key: `${transfer.prefix}${expected.key}`,
    }),
  )
  const stop = stopped.then(() => {
    throw new Error(`The target of ${expected.key} stopped before the end`)
  })
  stop.catch(() => undefined)
  const hash = createHash("sha256")
  let size = 0
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    size += chunk.length
    if (!target.write(chunk)) await Promise.race([once(target, "drain"), stop])
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
 * with an error. The error gives the exit code and the known kinds of the
 * tar messages, not the messages: a member name can hold ids or the private
 * file names of a customer.
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
  const kinds = new Set<string>()
  let others = 0
  const classify = (line: string) => {
    const kind = [
      "No space left on device",
      "Permission denied",
      "Read-only file system",
      "Not a directory",
      "Unexpected EOF in archive",
      "This does not look like a tar archive",
      "file changed as we read it",
      "Cannot open",
      "Cannot write",
      "Cannot stat",
    ].find((text) => line.includes(text))
    if (kind) kinds.add(kind)
    else others++
  }
  const counts = { files: 0, shards: 0 }
  const listed = (line: string) => {
    if (!line.startsWith("./")) classify(line)
    else if (!line.endsWith("/")) {
      counts.files++
      const shard = parseZoektShardBasename(basename(line))
      if (shard && !shard.temporary && line.endsWith(".zoekt")) counts.shards++
    }
  }
  const read = async (input: Readable, onLine: (line: string) => void) => {
    for await (const line of createInterface({ input })) onLine(line)
  }
  const reads = [read(child[listing], listed)]
  if (listing === "stdout") reads.push(read(child.stderr, classify))
  const done = (async () => {
    const [code] = (await once(child, "close")) as [number | null]
    await Promise.all(reads)
    if (code !== 0)
      throw new Error(
        `tar ${args[0]} exited with ${code}: ${[...kinds, `other messages: ${others}`].join("; ")}`,
      )
    return counts
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
    falkordb: {
      redisVersion: graph.redisVersion,
      moduleVersion: graph.moduleVersion,
      ...graphTotals(graph.graphs),
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

/** The number of graphs, and their total nodes and edges. */
export function graphTotals(graphs: { nodes: number; edges: number }[]) {
  return {
    graphs: graphs.length,
    nodes: graphs.reduce((sum, graph) => sum + graph.nodes, 0),
    edges: graphs.reduce((sum, graph) => sum + graph.edges, 0),
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The name and the code of a thrown value, without its message: a file
 * system or S3 message can hold a path or a key with ids.
 */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown"
  return "code" in error && typeof error.code === "string"
    ? `${error.name} ${error.code}`
    : error.name
}

/**
 * Runs a cutover tool: prints its JSON report to stdout, and exits 1 when
 * the report has `ok: false` or the tool throws. It sends the log events
 * before the exit.
 */
export function runCli(work: () => Promise<Record<string, unknown>>): void {
  try {
    initEvlog()
  } catch {
    // A task without the service env (AUTH_SECRET) keeps the evlog defaults.
  }
  void (async () => {
    let code = 1
    try {
      const report = await work()
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      code = report["ok"] === false ? 1 : 0
    } catch (error) {
      log.error({
        step: "codesearch.cutover.failed",
        error: errorMessage(error),
      })
    }
    await flushEvlog()
    process.exit(code)
  })()
}
