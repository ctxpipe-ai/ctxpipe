import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { pipeline } from "node:stream/promises"

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { z } from "zod"

import { log } from "../../observability/logger.js"

/**
 * The durable copy of the index artifacts in S3 (ADR-061 decision 10). The
 * local disk is a cache of it. Keys:
 *
 *   <prefix>/v1/<orgId>/<repoId>/<checkoutKey>/<kind>/manifest.json
 *   <prefix>/v1/<orgId>/<repoId>/<checkoutKey>/<kind>/<gen>/<file>
 *
 * The manifest PUT is the commit point of a publish. A change of the key
 * layout must change `v1`.
 */
export type ShardStore = {
  client: S3Client
  bucket: string
  /** `<prefix>/v1`, or `v1` when the URL has no prefix. */
  root: string
}

export type StoreAddress = {
  orgId: string
  repoId: string
  checkoutKey: string
  kind: "zoekt"
}

const manifestSchema = z.object({
  gen: z.string().regex(/^[0-9A-Za-z-]+$/),
  files: z.array(
    z.object({
      name: z.string().min(1),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
})

export type StoreManifest = z.infer<typeof manifestSchema>

let cached: { key: string; store: ShardStore | null } | undefined

/**
 * The store that `CODESEARCH_SHARD_STORE` (`s3://bucket/prefix`) names, or
 * null when the variable is unset: then codesearch keeps its artifacts on
 * the local disk only. The credentials and the region come from the SDK
 * default chain (the task role on AWS).
 */
export function shardStore(): ShardStore | null {
  const url = process.env["CODESEARCH_SHARD_STORE"] || undefined
  const endpoint =
    process.env["AWS_ENDPOINT_URL_S3"] || process.env["AWS_ENDPOINT_URL"]
  const key = `${url}|${endpoint}`
  if (cached?.key === key) return cached.store
  cached = { key, store: url ? storeFromUrl(url, endpoint) : null }
  return cached.store
}

function storeFromUrl(url: string, endpoint: string | undefined): ShardStore {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(
    url,
  )
  const bucket = match?.[1]
  if (!bucket)
    throw new Error(
      "CODESEARCH_SHARD_STORE must have the form s3://bucket or s3://bucket/prefix",
    )
  const prefix = (match[2] ?? "").replace(/^\/+|\/+$/g, "")
  return {
    client: new S3Client({
      // The manifest holds a sha256 for each file, and a fetch checks it.
      // The SDK's default CRC trailers need aws-chunked uploads, which
      // S3-compatible servers often refuse.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      // An S3-compatible server on a custom endpoint has no bucket DNS names.
      forcePathStyle: Boolean(endpoint),
    }),
    bucket,
    root: prefix ? `${prefix}/v1` : "v1",
  }
}

/** One key segment: no `/`, and not `.` or `..`. */
function segment(value: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_:.-]*$/.test(value))
    throw new Error(`Not a safe store key segment: ${value}`)
  return value
}

function addressPrefix(store: ShardStore, address: StoreAddress): string {
  return `${store.root}/${segment(address.orgId)}/${segment(address.repoId)}/${segment(address.checkoutKey)}/${address.kind}/`
}

/** A new generation id. It sorts by time, so a listing shows the newest last. */
function newGen(): string {
  const time = new Date().toISOString().replace(/[-:.]/g, "")
  return `${time}-${randomUUID().slice(0, 8)}`
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(createReadStream(path), hash)
  return hash.digest("hex")
}

/** Runs `fn` on each item, at most `limit` at the same time, in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
  return results
}

/** The current manifest of an address, or null when it has none. */
export async function readManifest(
  store: ShardStore,
  address: StoreAddress,
): Promise<StoreManifest | null> {
  try {
    const response = await store.client.send(
      new GetObjectCommand({
        Bucket: store.bucket,
        Key: `${addressPrefix(store, address)}manifest.json`,
      }),
    )
    const text = (await response.Body?.transformToString()) ?? ""
    return manifestSchema.parse(JSON.parse(text))
  } catch (error) {
    if (error instanceof NoSuchKey) return null
    throw error
  }
}

async function listKeys(store: ShardStore, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const page = await store.client.send(
      new ListObjectsV2Command({
        Bucket: store.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    )
    for (const object of page.Contents ?? [])
      if (object.Key) keys.push(object.Key)
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return keys
}

/** Deletes the keys. Any key that S3 does not delete is an error. */
async function deleteKeys(
  store: ShardStore,
  keys: readonly string[],
): Promise<void> {
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = keys.slice(start, start + 1000)
    const response = await store.client.send(
      new DeleteObjectsCommand({
        Bucket: store.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    )
    const failed = response.Errors ?? []
    if (failed.length > 0)
      throw new Error(
        `S3 did not delete ${failed.length} of ${batch.length} keys (first: ${failed[0]?.Code ?? "unknown"})`,
      )
  }
}

/**
 * Uploads the files as a new generation, then PUTs the manifest (the commit
 * point). A failure before the manifest PUT keeps the old manifest. After the
 * PUT, it deletes each generation except the new one and the one before it,
 * so a reader that read the old manifest can still download its files.
 */
export async function publishArtifact(
  store: ShardStore,
  address: StoreAddress,
  paths: readonly string[],
): Promise<StoreManifest> {
  const prefix = addressPrefix(store, address)
  const previous = await readManifest(store, address)
  const gen = newGen()
  const files = await mapLimit(paths, 4, async (path) => {
    const name = basename(path)
    const { size } = await stat(path)
    const sha256 = await fileSha256(path)
    await store.client.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: `${prefix}${gen}/${name}`,
        Body: createReadStream(path),
        ContentLength: size,
        // S3 refuses the object when the body does not match.
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      }),
    )
    return { name, size, sha256 }
  })
  const manifest: StoreManifest = { gen, files }
  await store.client.send(
    new PutObjectCommand({
      Bucket: store.bucket,
      Key: `${prefix}manifest.json`,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    }),
  )
  try {
    const keep = new Set([gen, previous?.gen])
    const old = (await listKeys(store, prefix)).filter((key) => {
      const rest = key.slice(prefix.length)
      return rest !== "manifest.json" && !keep.has(rest.split("/")[0])
    })
    await deleteKeys(store, old)
  } catch (error) {
    // The publish is committed. The next publish deletes the old generations.
    log.warn({
      step: "codesearch.store.old_generations_kept",
      kind: address.kind,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return manifest
}
