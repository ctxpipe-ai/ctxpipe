import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { trace } from "@opentelemetry/api"

/**
 * Global Git options for a fetch that `measuredGitFetch` measures. Git then
 * keeps each fetched pack as it came, also a pack of few objects, which Git
 * otherwise unpacks into loose objects. So the growth of the pack files is
 * the download.
 */
export const KEEP_FETCHED_PACK = ["-c", "fetch.unpackLimit=1"]

/** The bytes of the pack files of a work tree or a bare repository. */
async function packBytes(directory: string): Promise<number> {
  const gitDir = existsSync(join(directory, ".git"))
    ? join(directory, ".git")
    : directory
  const packs = join(gitDir, "objects", "pack")
  const names = await readdir(packs).catch(() => [])
  let total = 0
  for (const name of names)
    if (name.endsWith(".pack"))
      total += (await stat(join(packs, name)).catch(() => ({ size: 0 }))).size
  return total
}

/**
 * Run a `git fetch` into `directory` in a span `name`. The span records the
 * bytes that the fetch downloaded (`git.fetch.bytes`), so that the git
 * download of each workflow is known. The fetch must use
 * `KEEP_FETCHED_PACK`.
 */
export function measuredGitFetch<T>(
  name: string,
  directory: string,
  fetch: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan(name, async (span) => {
      try {
        const before = await packBytes(directory)
        const result = await fetch()
        span.setAttribute(
          "git.fetch.bytes",
          Math.max(0, (await packBytes(directory)) - before),
        )
        return result
      } finally {
        span.end()
      }
    })
}
