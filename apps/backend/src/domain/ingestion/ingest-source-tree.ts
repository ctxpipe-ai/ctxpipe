import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Env } from "../../config/env.js"
import { gitRemoteEnvironment } from "../../services/git/clone-tree.js"
import { resolveRepositoryReadCredential } from "../workspaces/resolve-revision.js"
import { heldScratch, holdScratch, releaseScratch } from "./held-scratch.js"
import { runGit } from "./run-git.js"

/*
 * The host's copy of the source tree at the run's SHA: commits and trees,
 * no blobs. The parent counts the candidate roots from it, and each step's
 * patch validator checks evidence paths against it. One worker process keeps
 * one copy for each run, SHA, and holder: the parent and each shard child
 * have their own copy, so a child that ends deletes only its own copy and
 * never the copy of a sibling that still runs. A copy that no one used for
 * an hour goes at the next fetch (`held-scratch.ts`).
 */

export type SourceTree = {
  /** Each file path at the SHA. */
  paths(): Promise<string[]>
  /** True when `path` (a file or a folder) exists at the SHA. */
  exists(path: string): Promise<boolean>
}

function treeKey(runId: string, sha: string, holder = "run") {
  return `tree:${runId}:${sha}:${holder}`
}

async function fetchTree(input: {
  orgId: string
  source: { url: string; githubConnectionId: string }
  sha: string
  env: Env
}): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-ingest-source-"))
  try {
    const token = await resolveRepositoryReadCredential({
      orgId: input.orgId,
      env: input.env,
      remote: {
        url: input.source.url,
        connectionId: input.source.githubConnectionId,
      },
    })
    await runGit(dir, ["init", "--quiet", "--bare"])
    await runGit(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "--filter=blob:none",
        "--",
        input.source.url,
        input.sha,
      ],
      { env: gitRemoteEnvironment({ url: input.source.url, token }) },
    )
    return { dir }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

/** The run's source tree; fetched once for each worker process and holder. */
export function ingestSourceTree(input: {
  orgId: string
  runId: string
  source: { url: string; githubConnectionId: string }
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
        "ls-tree",
        "--name-only",
        input.sha,
        "--",
        path,
      ])
      return out.length > 0
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
