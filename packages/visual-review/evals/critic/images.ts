// The case images of the bake-off. Each image is one asset of a public
// release, named `<sha256>.png` (CTX-1201). The runner gets an image only when
// it runs its case, checks it against the SHA-256 of the manifest, and keeps
// it in a local folder by hash.

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** The release that holds the images, as `pnpm visual:bakeoff:publish` makes it. */
export const imageRelease = {
  repo: "ctxpipe-ai/ctxpipe",
  tag: "visual-bakeoff-images",
}

/** The download URL of the release assets. */
export const releaseUrl = `https://github.com/${imageRelease.repo}/releases/download/${imageRelease.tag}`

/** The file name of an image in the image folder and in the release. */
export const imageFile = (sha256: string) => `${sha256}.png`

export const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

/**
 * A function that gives the bytes of the image with a SHA-256, from the
 * folder `cache`. An image that is not in the folder comes from
 * `release` and goes into the folder. An image whose bytes do not have its
 * SHA-256 throws, in the folder or from the release.
 */
export function imageStore(cache: string, release: string) {
  const pending = new Map<string, Promise<Buffer>>()
  const checked = (bytes: Buffer, sha256: string, from: string) => {
    if (sha256Of(bytes) !== sha256)
      throw new Error(
        `The image ${imageFile(sha256)} from ${from} does not have the SHA-256 of the manifest.`,
      )
    return bytes
  }
  const load = async (sha256: string) => {
    const path = join(cache, imageFile(sha256))
    const local = await readFile(path).catch(() => undefined)
    if (local) return checked(local, sha256, cache)
    const url = `${release}/${imageFile(sha256)}`
    const response = await fetch(url)
    if (!response.ok)
      throw new Error(
        `The image ${imageFile(sha256)} is not available: ${url} gave ${response.status}.`,
      )
    const bytes = checked(
      Buffer.from(await response.arrayBuffer()),
      sha256,
      url,
    )
    await mkdir(cache, { recursive: true })
    // A whole file or no file: a stopped download leaves no part.
    await writeFile(`${path}.part`, bytes)
    await rename(`${path}.part`, path)
    return bytes
  }
  return (sha256: string): Promise<Buffer> => {
    let bytes = pending.get(sha256)
    if (!bytes) {
      bytes = load(sha256)
      pending.set(sha256, bytes)
    }
    return bytes
  }
}
