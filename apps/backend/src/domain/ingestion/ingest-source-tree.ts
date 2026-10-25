import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Env } from "../../config/env.js"
import { gitRemoteEnvironment } from "../../services/git/clone-tree.js"
import {
  plainGitFetchLimits,
  plainGitRemote,
} from "../../services/git/plain-git-remote.js"
import { resolveRepositoryReadCredential } from "../workspaces/resolve-revision.js"
import { heldScratch, holdScratch, releaseScratch } from "./held-scratch.js"
import type { IngestSource } from "./ingestion-run.js"
import { MAX_SOURCE_READ_BYTES } from "./patch-validator.js"
import { GitOutputTooLargeError, runGit } from "./run-git.js"

/*
 * The host's copy of the source tree at the run's SHA: commits and trees,
 * and no blobs for a GitHub source. The parent counts the candidate roots
 * from it, and each step's patch validator checks evidence paths and quotes
 * against it. One worker process keeps one copy for each run, SHA, and
 * holder: the parent and each shard child have their own copy, so a child
 * that ends deletes only its own copy and never the copy of a sibling that
 * still runs. A copy that no one used for an hour goes at the next fetch
 * (`held-scratch.ts`).
 *
 * A plain git source (CTX-815) is different: the copy also gets each blob
 * up to the read limit in the one fetch, with a time limit and a size
 * limit. A later read never connects to the plain git host, so the evidence
 * paths that a step cites cannot send a signal to that host.
 */

type SourceTree = {
  /** Each file path at the SHA. */
  paths(): Promise<string[]>
  /** True when `path` (a file or a folder) exists at the SHA. */
  exists(path: string): Promise<boolean>
  /**
   * The text of the file `path` at the SHA (a symlink gives its target), or
   * null when the path is not exactly a file or is larger than the read
   * limit. For a GitHub source, the copy has no blobs, so git gets the blob
   * from the source remote with a read credential; a fault of the remote or
   * of the credential throws. A plain git source never fetches here: a blob
   * that the first fetch did not get gives null.
   */
  read(path: string): Promise<string | null>
}

function treeKey(runId: string, sha: string, holder = "run") {
  return `tree:${runId}:${sha}:${holder}`
}

async function fetchTree(input: {
  orgId: string
  source: IngestSource
  sha: string
  env: Env
}): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-ingest-source-"))
  try {
    await runGit(dir, ["init", "--quiet", "--bare"])
    if (input.source.kind === "git") {
      // Each blob up to the read limit, now: a later read does not fetch.
      // `blob:limit=<n>` leaves out each blob of n bytes or more.
      const remote = await plainGitRemote(input.source.url)
      const limits = plainGitFetchLimits()
      await runGit(
        dir,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          "--depth=1",
          `--filter=blob:limit=${MAX_SOURCE_READ_BYTES + 1}`,
          "--",
          remote.url,
          input.sha,
        ],
        {
          cleanEnv: remote.env,
          timeoutMs: limits.timeoutMs,
          maxFileBytes: limits.maxFileBytes,
        },
      )
      return { dir }
    }
    const remote = await githubSourceRemote({ ...input, source: input.source })
    await runGit(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "--filter=blob:none",
        "--",
        remote.url,
        input.sha,
      ],
      { env: remote.env },
    )
    return { dir }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

/** The URL and the git environment of one read of a GitHub source. */
async function githubSourceRemote(input: {
  orgId: string
  source: Exclude<IngestSource, { kind: "git" }>
  env: Env
}): Promise<{ url: string; env: NodeJS.ProcessEnv }> {
  const token = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env: input.env,
    remote: {
      url: input.source.url,
      connectionId: input.source.githubConnectionId,
    },
  })
  return {
    url: input.source.url,
    env: gitRemoteEnvironment({ url: input.source.url, token }),
  }
}

/** A download that git stopped leaves a partial pack; delete it. */
async function removeTemporaryPacks(repo: string) {
  const packs = join(repo, "objects/pack")
  for (const name of await readdir(packs))
    if (name.startsWith("tmp_pack_"))
      await rm(join(packs, name), { force: true })
}

/** The run's source tree; fetched once for each worker process and holder. */
export function ingestSourceTree(input: {
  orgId: string
  runId: string
  source: IngestSource
  sha: string
  env: Env
  /** `${mode}:${shard}` for a shard child; the parent has none. */
  holder?: string
}): SourceTree {
  const key = treeKey(input.runId, input.sha, input.holder)
  const dir = async () => (await holdScratch(key, () => fetchTree(input))).dir
  return {
    async paths() {
      const out = await runGit(await dir(), [
        "--no-lazy-fetch",
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        input.sha,
      ])
      return out.toString("utf8").split("\0").filter(Boolean)
    },
    async exists(path) {
      const out = await runGit(await dir(), [
        "--no-lazy-fetch",
        "ls-tree",
        "--name-only",
        input.sha,
        "--",
        path,
      ])
      return out.length > 0
    },
    async read(path) {
      const repo = await dir()
      if (!path) return null
      // `ls-tree` reads the tree only, so a folder or a gitlink gets no blob
      // fetch. It matches a path as a prefix, so keep only the entry whose
      // path is the requested path.
      const listed = (
        await runGit(repo, [
          "--no-lazy-fetch",
          "--literal-pathspecs",
          "ls-tree",
          "-z",
          input.sha,
          "--",
          path,
        ])
      )
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta = "", name] = line.split("\t")
          const [mode, type, oid] = meta.split(" ")
          return { mode, type, oid, name }
        })
      const entry = listed.find((e) => e.name === path)
      // A symlink is a blob whose text is its target, as in `gitSource`.
      if (!entry || entry.type !== "blob" || !entry.oid) return null
      const { oid } = entry
      const held = await runGit(repo, [
        "--no-lazy-fetch",
        "cat-file",
        "-e",
        oid,
      ]).then(
        () => true,
        () => false,
      )
      if (!held) {
        // A plain git source got each blob that it can read in the first
        // fetch; it never connects to the plain git host again.
        const { source } = input
        if (source.kind === "git") return null
        // A network or credential fault throws: the caller must see
        // an outside-service fault, not a refused quote. The size of a blob
        // is not in the tree and `ls-tree -l` fetches every blob it lists,
        // so the size limit is on the download: git dies when it writes more
        // than the limit.
        const remote = await githubSourceRemote({ ...input, source })
        try {
          await runGit(
            repo,
            [
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              "--recurse-submodules=no",
              "--filter=blob:none",
              remote.url,
              oid,
            ],
            {
              env: remote.env,
              maxFileBytes: MAX_SOURCE_READ_BYTES + 64 * 1024,
            },
          )
        } catch (error) {
          if (!(error instanceof Error && /signal 25/.test(error.message)))
            throw error
          await removeTemporaryPacks(repo)
          return null
        }
      }
      try {
        return (
          await runGit(repo, ["--no-lazy-fetch", "cat-file", "blob", oid], {
            maxOutputBytes: MAX_SOURCE_READ_BYTES,
          })
        ).toString("utf8")
      } catch (error) {
        if (error instanceof GitOutputTooLargeError) return null
        throw error
      }
    },
  }
}

/** Delete this process's copy of the run's source tree for one holder. */
export function releaseIngestSourceTree(
  runId: string,
  sha: string,
  holder?: string,
): Promise<void> {
  return releaseScratch(treeKey(runId, sha, holder))
}

/** The number of source tree copies that this process holds (for tests). */
export function heldIngestSourceTrees(runId: string): number {
  return heldScratch(`tree:${runId}:`)
}
