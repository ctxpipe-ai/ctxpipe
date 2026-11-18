import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { trace } from "@opentelemetry/api"

/**
 * Run a `git fetch` in a span `name` that records the bytes that the fetch
 * downloaded (`git.fetch.bytes`), so that the git download of each workflow
 * is known. `fetch` must give the environment that it gets to the Git
 * process: there, `GIT_TRACE_PACKFILE` makes Git write a copy of each pack
 * that it receives, as it came. The size of that copy is the download, also
 * for a thin pack whose delta bases the directory already has.
 */
export function measuredGitFetch<T>(
  name: string,
  fetch: (env: { GIT_TRACE_PACKFILE: string }) => Promise<T>,
): Promise<T> {
  return trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan(name, async (span) => {
      const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-fetch-bytes-"))
      const file = join(scratch, "received.pack")
      try {
        return await fetch({ GIT_TRACE_PACKFILE: file })
      } finally {
        // Also a fetch that fails can have received a pack. A fetch that
        // needs no object receives no pack and writes no file.
        span.setAttribute(
          "git.fetch.bytes",
          (await stat(file).catch(() => ({ size: 0 }))).size,
        )
        span.end()
        await rm(scratch, { recursive: true, force: true })
      }
    })
}
