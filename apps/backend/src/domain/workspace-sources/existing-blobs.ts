import { spawn } from "node:child_process"
import { log } from "../../observability/logger.js"
import { listTreeBlobs } from "../../services/git/pack.js"
import { gitBlobSha, readSourcesStamp, stampSources } from "./stamp-sources.js"
import { type ExistingBlob, type StampOwner, stampOwnerOf } from "./sync.js"

/**
 * The blobs under the managed paths of `owners` in a tree, as the adapters
 * wrote them (ADR-050). The sha of a Markdown file is the one of its text
 * without the `sources` list. A Markdown file with front matter and a wrong
 * or missing list also gets its text with the right list (`restamped`).
 * `root` is the Workspace root in the repository; paths are relative to it.
 */
export async function listExistingBlobs(
  directory: string,
  treeish: string,
  owners: readonly StampOwner[],
  root = "",
): Promise<ExistingBlob[]> {
  const prefixes = [...new Set(owners.flatMap((owner) => owner.prefixes))]
  if (!prefixes.length) return []
  const blobs = (
    await listTreeBlobs(
      directory,
      treeish,
      prefixes.map((prefix) => `${root}${prefix}`),
    )
  ).map((blob) => ({ ...blob, path: blob.path.slice(root.length) }))
  const marked = blobs.filter((blob) => blob.path.endsWith(".md"))
  const read = new Map<string, ExistingBlob>()
  let index = 0
  let skipped = 0
  for await (const body of catFileBatch(
    directory,
    marked.map((blob) => blob.sha),
  )) {
    const blob = marked[index++]
    if (!blob) break
    // Too large to read: the adapter path decides about this file.
    if (!body) {
      skipped++
      continue
    }
    read.set(blob.path, readStamp(blob, body, stampOwnerOf(owners, blob.path)))
  }
  if (skipped)
    log.warn({
      step: "existing-blobs",
      message: "Markdown blobs over the size cap are not read for stamping",
      skipped,
    })
  return blobs.map((blob) => read.get(blob.path) ?? blob)
}

/** A Markdown blob over this size is not read into memory. */
const maxBlobBytes = 2 * 1024 * 1024

function readStamp(
  blob: { path: string; sha: string },
  body: Buffer,
  sourcePath: string | null,
): ExistingBlob {
  const text = body.toString("utf8")
  const stamp = readSourcesStamp(text)
  // No front matter: the sync does not stamp the file.
  if (!stamp) return blob
  const sha = stamp.sources ? gitBlobSha(stamp.stripped) : blob.sha
  const right =
    !sourcePath ||
    (stamp.sources?.length === 1 && stamp.sources[0] === sourcePath)
  return right
    ? { path: blob.path, sha }
    : { path: blob.path, sha, restamped: stampSources(text, [sourcePath]) }
}

/**
 * The contents of the blobs `shas`, in order, from one `git cat-file
 * --batch`. It holds one blob in memory at a time, so a large mirror does
 * not fill an output buffer. A blob over `maxBlobBytes` is dropped while it
 * streams and yields null.
 */
async function* catFileBatch(
  directory: string,
  shas: readonly string[],
): AsyncGenerator<Buffer | null> {
  if (!shas.length) return
  const child = spawn(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-C", directory, "cat-file", "--batch"],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  )
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
  const stderr: Buffer[] = []
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  child.stdin.end(`${shas.join("\n")}\n`)
  try {
    let pending: Buffer = Buffer.alloc(0)
    let size: number | null = null
    // Bytes of an oversized blob (and its newline) still to drop.
    let dropping = 0
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      for (;;) {
        if (dropping) {
          const drop = Math.min(dropping, pending.length)
          pending = pending.subarray(drop)
          dropping -= drop
          if (dropping) break
          yield null
          continue
        }
        if (size === null) {
          const end = pending.indexOf(10)
          if (end < 0) break
          const header = pending.subarray(0, end).toString()
          const match = /^[0-9a-f]+ blob (\d+)$/.exec(header)
          if (!match) throw new Error(`Git cannot read the blob: ${header}`)
          size = Number(match[1])
          pending = pending.subarray(end + 1)
          if (size > maxBlobBytes) {
            dropping = size + 1
            size = null
            continue
          }
        }
        // Each blob ends with a newline after its content.
        if (pending.length < size + 1) break
        yield pending.subarray(0, size)
        pending = pending.subarray(size + 1)
        size = null
      }
    }
    const code = await exited
    if (code !== 0)
      throw new Error(
        `git cat-file exited with ${code}: ${Buffer.concat(stderr).toString().trim()}`,
      )
  } finally {
    child.kill()
  }
}
