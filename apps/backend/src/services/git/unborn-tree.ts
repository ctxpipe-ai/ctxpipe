import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitRemoteEnvironment } from "./clone-tree.js"
import { type GitFileChange, gitFileBytes } from "./file-change.js"
import { captureGitPack, nativeGit } from "./pack.js"

export type UnbornGitTree = { tree: string; objects: string }

async function withEmptyGitDirectory<T>(
  operation: (directory: string) => Promise<T>,
  tree?: UnbornGitTree,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-unborn-write-"))
  try {
    await nativeGit(directory, ["init", "--template=", "--object-format=sha1"])
    if (tree)
      await nativeGit(
        directory,
        ["index-pack", "--stdin"],
        Buffer.from(tree.objects, "base64"),
      )
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

export async function stageUnbornGitFiles(
  files: readonly GitFileChange[],
): Promise<UnbornGitTree> {
  return withEmptyGitDirectory(async (directory) => {
    for (const file of files) {
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
        `100644,${blob},${file.path}`,
      ])
    }
    const tree = (await nativeGit(directory, ["write-tree"])).toString().trim()
    const objects = await nativeGit(
      directory,
      ["pack-objects", "--stdout", "--revs"],
      `${tree}\n`,
    )
    return { tree, objects: objects.toString("base64") }
  })
}

export async function validateUnbornGitTree(
  tree: UnbornGitTree,
  allowedPaths: readonly string[],
): Promise<void> {
  await withEmptyGitDirectory(async (directory) => {
    const paths = (
      await nativeGit(directory, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        tree.tree,
      ])
    )
      .toString()
      .split("\0")
      .filter(Boolean)
    if (!paths.length || paths.some((path) => !allowedPaths.includes(path)))
      throw new Error("Invalid bootstrap root tree")
  }, tree)
}

export async function commitUnbornGitTree(
  tree: UnbornGitTree,
  input: { subject: string; createdAt: Date | string },
) {
  return withEmptyGitDirectory(async (directory) => {
    const date = new Date(input.createdAt).toISOString()
    const sha = (
      await nativeGit(
        directory,
        ["commit-tree", tree.tree],
        `${input.subject}\n`,
        {
          ...process.env,
          GIT_AUTHOR_NAME: "ctxpipe[bot]",
          GIT_AUTHOR_EMAIL: "ctxpipe[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "ctxpipe[bot]",
          GIT_COMMITTER_EMAIL: "ctxpipe[bot]@users.noreply.github.com",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      )
    )
      .toString()
      .trim()
    return captureGitPack(directory, sha)
  }, tree)
}
