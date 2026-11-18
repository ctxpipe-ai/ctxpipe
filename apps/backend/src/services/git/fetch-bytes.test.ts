import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, expect, it } from "vitest"

import { recordSpans } from "../../../test/spans.js"
import { listMarkdownFilesAtGitSha } from "./clone-tree.js"
import { measuredGitFetch } from "./fetch-bytes.js"
import { fetchGitCommits, withGitDirectory } from "./pack.js"

const execFileAsync = promisify(execFile)
const spans = recordSpans()

let remote: string | undefined
afterEach(async () => {
  if (remote) await rm(remote, { recursive: true, force: true })
  remote = undefined
})

/**
 * A remote with one Markdown file of 256 KiB of random base64 text. Random
 * base64 compresses to no less than 3/4 of its size, so a fetch of the file
 * downloads at least 192 KiB.
 */
async function remoteWithLargeFile() {
  remote = await mkdtemp(join(tmpdir(), "ctxpipe-fetch-bytes-"))
  const dir = remote
  const git = async (...args: string[]) =>
    (
      await execFileAsync("git", [
        "-C",
        dir,
        "-c",
        "user.name=Contract",
        "-c",
        "user.email=contract@example.test",
        ...args,
      ])
    ).stdout.trim()
  await git("init", "-b", "main")
  await git("config", "uploadpack.allowFilter", "true")
  await git("config", "uploadpack.allowAnySHA1InWant", "true")
  await writeFile(join(dir, "small.md"), "# Small\n")
  await git("add", ".")
  await git("commit", "-q", "-m", "Small")
  await writeFile(
    join(dir, "large.md"),
    randomBytes(192 * 1024).toString("base64"),
  )
  await git("add", ".")
  await git("commit", "-q", "-m", "Large")
  return { url: dir, sha: await git("rev-parse", "HEAD") }
}

function fetchedBytes(name: string): number {
  const span = spans.spanNamed(name)
  if (!span) throw new Error(`No span ${name}`)
  return Number(span.attributes["git.fetch.bytes"])
}

it("records the bytes that each fetch of a hydrate tree read downloads", async () => {
  const { url, sha } = await remoteWithLargeFile()
  await listMarkdownFilesAtGitSha({ url, sha, includeIntroducingCommits: true })
  // The tip fetch downloads the large file once.
  expect(fetchedBytes("git.fetch-tip")).toBeGreaterThanOrEqual(192 * 1024)
  expect(fetchedBytes("git.fetch-tip")).toBeLessThan(512 * 1024)
  // The history fetch downloads commits and trees, and no blob.
  expect(fetchedBytes("git.fetch-history")).toBeGreaterThan(0)
  expect(fetchedBytes("git.fetch-history")).toBeLessThan(16 * 1024)
})

it("records the thin pack that Git receives, not the delta bases that Git adds to it", async () => {
  const { url, sha: first } = await remoteWithLargeFile()
  const git = (...args: string[]) =>
    execFileAsync("git", [
      "-C",
      url,
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      ...args,
    ])
  await appendFile(join(url, "large.md"), "\nOne more line.\n")
  await git("commit", "-q", "-am", "Edit")
  const second = (await git("rev-parse", "HEAD")).stdout.trim()
  await withGitDirectory(
    second,
    async (directory) => {
      const fetch = (sha: string) =>
        measuredGitFetch("git.fetch-test", (traced) =>
          execFileAsync("git", ["-C", directory, "fetch", "-q", url, sha], {
            env: { ...process.env, ...traced },
          }),
        )
      await fetch(first)
      expect(fetchedBytes("git.fetch-test")).toBeGreaterThanOrEqual(192 * 1024)
      // Git offers only the commits that a ref names. With a ref on the
      // first commit, the edit comes as a small delta against its blob.
      await execFileAsync("git", [
        "-C",
        directory,
        "update-ref",
        "refs/heads/base",
        first,
      ])
      spans.reset()
      await fetch(second)
      expect(fetchedBytes("git.fetch-test")).toBeGreaterThan(0)
      expect(fetchedBytes("git.fetch-test")).toBeLessThan(16 * 1024)
      // A fetch of a commit that a ref names downloads nothing.
      await execFileAsync("git", [
        "-C",
        directory,
        "update-ref",
        "refs/heads/base",
        second,
      ])
      spans.reset()
      await fetch(second)
      expect(fetchedBytes("git.fetch-test")).toBe(0)
    },
    undefined,
    null,
  )
})

it("records that a fetch at depth 1 downloads each blob again, also one that the directory has", async () => {
  const { url, sha } = await remoteWithLargeFile()
  await withGitDirectory(
    sha,
    async (directory) => {
      await fetchGitCommits(directory, { url, shas: [sha] })
      expect(fetchedBytes("git.fetch-commits")).toBeGreaterThanOrEqual(
        192 * 1024,
      )
      // Git does not use the objects below a shallow boundary as a base.
      spans.reset()
      await fetchGitCommits(directory, { url, shas: [sha] })
      expect(fetchedBytes("git.fetch-commits")).toBeGreaterThanOrEqual(
        192 * 1024,
      )
    },
    undefined,
    null,
  )
})
