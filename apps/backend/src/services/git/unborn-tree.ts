import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { gitRemoteEnvironment } from "./clone-tree.js"
import { type GitFileChange, gitFileBytes } from "./file-change.js"
import {
  type GitWriteCommit,
  nativeGit,
  type PublishGitCommit,
} from "./pack.js"
import {
  workspaceRelativePath,
  workspaceRepositoryPath,
} from "./root-folder.js"
import { commitGitTreeIn } from "./write-tree.js"

async function withEmptyGitDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-unborn-write-"))
  try {
    await nativeGit(directory, ["init", "--template=", "--object-format=sha1"])
    return await operation(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Git protocol v2 clone preserves an unborn remote HEAD; ls-remote alone does not. */
export async function readUnbornRemoteBranch(input: {
  url: string
  token?: string
}): Promise<string | null> {
  return withEmptyGitDirectory(async (directory) => {
    const env = gitRemoteEnvironment(input)
    const heads = await nativeGit(
      directory,
      ["ls-remote", "--heads", "--", input.url],
      undefined,
      env,
    )
    if (heads.toString().trim()) return null
    await nativeGit(
      directory,
      [
        "-c",
        "protocol.version=2",
        "clone",
        "--no-checkout",
        "--",
        input.url,
        "remote",
      ],
      undefined,
      env,
    )
    const branch = (
      await nativeGit(join(directory, "remote"), [
        "symbolic-ref",
        "--short",
        "HEAD",
      ])
    )
      .toString()
      .trim()
    await nativeGit(directory, ["check-ref-format", `refs/heads/${branch}`])
    return branch
  })
}

/**
 * Stage, check, and commit the first commit of an unborn repository in one
 * Git directory, and publish it before the directory goes away (CTX-1235).
 * Paths are relative to `root`, the Workspace root folder. Each path must be
 * in `allowedPaths`.
 */
export async function prepareUnbornGitCommit(input: {
  files: readonly GitFileChange[]
  root: string
  allowedPaths: readonly string[]
  subject: string
  createdAt: Date | string
  publish: PublishGitCommit
}): Promise<GitWriteCommit> {
  return withEmptyGitDirectory(async (directory) => {
    for (const file of input.files) {
      const blob = (
        await nativeGit(
          directory,
          ["hash-object", "-w", "--stdin"],
          gitFileBytes(file),
        )
      )
        .toString()
        .trim()
      await nativeGit(directory, [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},${workspaceRepositoryPath(input.root, file.path)}`,
      ])
    }
    const tree = (await nativeGit(directory, ["write-tree"])).toString().trim()
    const paths = (
      await nativeGit(directory, ["ls-tree", "-r", "--name-only", "-z", tree])
    )
      .toString()
      .split("\0")
      .filter(Boolean)
    if (
      !paths.length ||
      paths.some((path) => {
        const relative = workspaceRelativePath(input.root, path)
        return relative === null || !input.allowedPaths.includes(relative)
      })
    )
      throw new Error("Invalid bootstrap root tree")
    const sha = await commitGitTreeIn(directory, {
      tree,
      parents: [],
      subject: input.subject,
      createdAt: input.createdAt,
    })
    await input.publish(directory, sha)
    return {
      sha,
      tree,
      ...(input.root ? { root: input.root } : {}),
      base: null,
    }
  })
}
