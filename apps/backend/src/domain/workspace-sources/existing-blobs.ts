import { listTreeBlobs, nativeGit } from "../../services/git/pack.js"
import { gitBlobSha, readSourcesStamp } from "./stamp-sources.js"
import type { ExistingBlob } from "./sync.js"

/**
 * The blobs of a tree. For each Markdown file under `stampRoot` it also reads
 * the `sources` front matter, so that the sync can tell a file with the
 * wrong or no list from a file that did not change (ADR-050).
 */
export async function listExistingBlobs(
  directory: string,
  treeish: string,
  stampRoot: string,
): Promise<ExistingBlob[]> {
  const blobs = await listTreeBlobs(directory, treeish)
  const marked = blobs.filter(
    (blob) => blob.path.startsWith(stampRoot) && blob.path.endsWith(".md"),
  )
  if (!marked.length) return blobs
  const output = await nativeGit(
    directory,
    ["cat-file", "--batch"],
    `${marked.map((blob) => blob.sha).join("\n")}\n`,
  )
  const stamps = new Map<string, ExistingBlob>()
  let offset = 0
  for (const blob of marked) {
    const end = output.indexOf("\n", offset)
    const size = Number(output.subarray(offset, end).toString().split(" ")[2])
    const body = output.subarray(end + 1, end + 1 + size)
    offset = end + 1 + size + 1
    const { sources, stripped } = readSourcesStamp(body.toString("utf8"))
    stamps.set(blob.path, {
      ...blob,
      sources,
      ...(sources ? { unstampedSha: gitBlobSha(stripped) } : {}),
    })
  }
  return blobs.map((blob) => stamps.get(blob.path) ?? blob)
}
