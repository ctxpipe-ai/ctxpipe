import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initLogger } from "evlog"
import { afterEach, expect, it, vi } from "vitest"

import { recordSpans } from "../../../test/spans.js"
import { startGitHttpServer } from "../../test/git-http-server.js"
import { fetchGitCommits, nativeGit } from "./pack.js"

const spans = recordSpans()

const servers: Array<{ stop: () => Promise<void> }> = []
const directories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  initLogger({ enabled: false })
  for (const server of servers.splice(0)) await server.stop()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

/**
 * A repository of 64 files of random bytes (about 1 MiB of pack), below a
 * root that a Git HTTP server serves.
 */
async function largeRepository() {
  const root = await temporaryDirectory("ctxpipe-fetch-remote-")
  const directory = join(root, "context")
  await mkdir(directory)
  await nativeGit(directory, ["init", "-q"])
  await nativeGit(directory, [
    "config",
    "uploadpack.allowAnySHA1InWant",
    "true",
  ])
  for (let file = 0; file < 64; file++)
    await writeFile(join(directory, `file-${file}.bin`), randomBytes(16_384))
  const commit = async (message: string) => {
    await nativeGit(directory, ["add", "-A"])
    await nativeGit(directory, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      message,
    ])
    return (await nativeGit(directory, ["rev-parse", "HEAD"])).toString().trim()
  }
  return { root, directory, commit }
}

async function emptyGitDirectory() {
  const directory = await temporaryDirectory("ctxpipe-fetch-local-")
  await nativeGit(directory, ["init", "-q"])
  return directory
}

async function serve(
  root: string,
  answer?: (request: IncomingMessage, response: ServerResponse) => boolean,
  options?: Parameters<typeof startGitHttpServer>[2],
) {
  const server = await startGitHttpServer(root, answer, options)
  servers.push(server)
  return { ...server, url: `http://127.0.0.1:${server.port}/context` }
}

function fetchedBytes() {
  return spans
    .finishedSpans()
    .filter((span) => span.name === "git.fetch-commits")
    .map((span) => Number(span.attributes["git.fetch.bytes"]))
}

async function realDelay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

it("downloads only the changed objects when it fetches a later commit of the same remote (CTX-1601)", async () => {
  const remote = await largeRepository()
  const first = await remote.commit("first")
  const server = await serve(remote.root)

  const before = await emptyGitDirectory()
  await fetchGitCommits(before, { url: server.url, shas: [first] })
  await writeFile(join(remote.directory, "file-0.bin"), "changed\n")
  const second = await remote.commit("second")
  const after = await emptyGitDirectory()
  await fetchGitCommits(after, { url: server.url, shas: [second] })

  const [full, changed] = fetchedBytes()
  expect(full).toBeGreaterThan(1_000_000)
  expect(changed).toBeLessThan(10_000)
  // The directory has the whole tree of the later commit, not only the
  // changed file.
  expect(
    (await nativeGit(after, ["show", `${second}:file-0.bin`])).toString(),
  ).toBe("changed\n")
  expect(
    await nativeGit(after, ["show", `${second}:file-63.bin`]),
  ).toHaveLength(16_384)
})

it("gives no object of an earlier fetch to a fetch that the Git host refuses", async () => {
  const remote = await largeRepository()
  const sha = await remote.commit("first")
  const authorization = `Basic ${Buffer.from("x-access-token:good-token").toString("base64")}`
  const server = await serve(remote.root, (request, response) => {
    if (request.headers.authorization === authorization) return false
    response
      .writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' })
      .end()
    return true
  })

  await fetchGitCommits(await emptyGitDirectory(), {
    url: server.url,
    shas: [sha],
    token: "good-token",
  })
  const refused = await emptyGitDirectory()
  await expect(
    fetchGitCommits(refused, {
      url: server.url,
      shas: [sha],
      token: "other-token",
    }),
  ).rejects.toThrow(/401|Authentication failed|could not read Username/)
  await expect(nativeGit(refused, ["cat-file", "-t", sha])).rejects.toThrow()
})

it("finishes a slow fetch that makes progress past 60 s (CTX-1601)", async () => {
  const remote = await largeRepository()
  const sha = await remote.commit("first")
  // About 1 MiB in parts of 16 KiB: about 64 parts.
  const server = await serve(remote.root, undefined, {
    throttle: { bytes: 16_384, everyMs: 20 },
  })
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
  const startedAt = Date.now()

  const directory = await emptyGitDirectory()
  let settled = false
  const slowFetch = fetchGitCommits(directory, { url: server.url, shas: [sha] })
  void slowFetch.finally(() => (settled = true)).catch(() => {})
  // Each 10 ms of real time is 1 s on the clock of the fetch: one part of
  // the pack comes each 2 s, and the whole fetch takes about 2 min.
  while (!settled) {
    await realDelay(10)
    await vi.advanceTimersByTimeAsync(1_000)
  }

  await expect(slowFetch).resolves.toBeUndefined()
  expect(Date.now() - startedAt).toBeGreaterThan(60_000)
  expect(await nativeGit(directory, ["cat-file", "-t", sha])).toEqual(
    Buffer.from("commit\n"),
  )
})

it("stops a fetch that gets no data for 60 s once, then fails the next fetches of that remote at once for 5 min (CTX-1601)", async () => {
  const remote = await largeRepository()
  const sha = await remote.commit("first")
  let stall = true
  const posts: string[] = []
  const server = await serve(remote.root, (request, response) => {
    if (request.method !== "POST") return false
    posts.push(request.url ?? "")
    if (!stall) return false
    // The Git host accepts the request, then sends nothing.
    response.writeHead(200, {
      "Content-Type": "application/x-git-upload-pack-result",
    })
    response.flushHeaders()
    return true
  })
  const events: Record<string, unknown>[] = []
  initLogger({
    pretty: false,
    drain: (ctx) => {
      for (const item of Array.isArray(ctx) ? ctx : [ctx])
        events.push(item.event as Record<string, unknown>)
    },
  })
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })

  const stalled = fetchGitCommits(await emptyGitDirectory(), {
    url: server.url,
    shas: [sha],
  })
  const outcome = stalled.then(
    () => "fetched",
    (error: Error) => error.message,
  )
  while (posts.length === 0) await realDelay(10)
  await vi.advanceTimersByTimeAsync(61_000)
  expect(await outcome).toMatch(/sent no data for 60 s/)
  // No second or third attempt in the same step.
  expect(posts).toHaveLength(1)

  const paused = fetchGitCommits(await emptyGitDirectory(), {
    url: server.url,
    shas: [sha],
  })
  await expect(paused).rejects.toThrow(
    /stopped at a time limit .* tries this repository again after/,
  )
  expect(posts).toHaveLength(1)
  expect(events).toContainEqual(
    expect.objectContaining({
      step: "git.fetch_paused",
      "git.remote.paused_until": expect.any(String),
    }),
  )

  // After the pause, a fetch goes to the Git host again.
  stall = false
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  const directory = await emptyGitDirectory()
  await fetchGitCommits(directory, { url: server.url, shas: [sha] })
  expect(posts.length).toBeGreaterThan(1)
  expect(await nativeGit(directory, ["cat-file", "-t", sha])).toEqual(
    Buffer.from("commit\n"),
  )
})
