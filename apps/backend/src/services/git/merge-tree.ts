import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { GitFileChange } from "./file-change.js"
import {
  type GitPack,
  type GitRemoteRead,
  nativeGit,
  packGitObjects,
  withGitDirectory,
} from "./pack.js"
import { workspaceRelativePath } from "./root-folder.js"
import {
  commitGitTree,
  type StagedGitTree,
  stageGitFiles,
} from "./write-tree.js"

export type GitMergeConflict = {
  path: string
  base: string | null
  current: string | null
  incoming: string | null
}

type GitMergeResult = {
  staged: StagedGitTree
  paths: string[]
  conflicts: GitMergeConflict[]
}

/** Rebase an unpushed file command using Git's native three-way tree merge. */
export async function mergeGitFiles(input: {
  pack: GitPack
  previousSha: string
  files: readonly GitFileChange[]
  deletePaths: readonly string[]
  read: GitRemoteRead | null
}): Promise<GitMergeResult | null> {
  const candidateTree = await stageGitFiles(
    { ...input.pack, sha: input.previousSha },
    input.files,
    input.deletePaths,
    input.read,
  )
  // This unreachable object gives merge-tree a commit identity for the captured command.
  const candidate = await commitGitTree(
    candidateTree,
    {
      subject: "Captured unpushed workspace change",
      createdAt: "2000-01-01T00:00:00.000Z",
    },
    input.read,
  )
  // Paths in the result are relative to the Workspace root folder.
  const rootRelative = (path: string) => {
    const relative = workspaceRelativePath(input.pack.root ?? "", path)
    if (relative === null)
      throw new Error(
        "The merge changes a path outside the Workspace root folder",
      )
    return relative
  }
  return withGitDirectory(
    input.pack.sha,
    async (directory) => {
      await nativeGit(
        directory,
        ["index-pack", "--stdin"],
        Buffer.from(candidate.objects, "base64"),
      )
      let conflicted = false
      const output = await nativeGit(directory, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        `--merge-base=${input.previousSha}`,
        input.pack.sha,
        candidate.sha,
      ]).catch((error: unknown) => {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== 1 ||
          !("stdout" in error) ||
          !Buffer.isBuffer(error.stdout)
        )
          throw error
        conflicted = true
        return error.stdout
      })
      const entries = output.toString().split("\0")
      const tree = entries.shift()?.trim()
      if (!tree || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree))
        throw new Error("Native merge did not produce a tree")
      const paths = (
        await nativeGit(directory, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          input.pack.sha,
          tree,
        ])
      )
        .toString()
        .split("\0")
        .filter(Boolean)
      const conflicts: GitMergeConflict[] = []
      if (conflicted) {
        const read = async (sha: string, path: string) => {
          const entry = await nativeGit(directory, [
            "ls-tree",
            "-z",
            sha,
            "--",
            path,
          ])
          if (!entry.length) return null
          if (!/^100(?:644|755) blob /.test(entry.toString()))
            throw new Error("Semantic merge requires regular text files")
          const content = await nativeGit(directory, ["show", `${sha}:${path}`])
          if (content.includes(0))
            throw new Error("Semantic merge cannot resolve binary conflicts")
          return new TextDecoder("utf-8", { fatal: true }).decode(content)
        }
        for (const path of entries) {
          if (!path) break
          conflicts.push({
            path: rootRelative(path),
            base: await read(input.previousSha, path),
            current: await read(input.pack.sha, path),
            incoming: await read(candidate.sha, path),
          })
        }
        if (!conflicts.length)
          throw new Error("Native merge conflict has no file paths")
      }
      if (!paths.length && !conflicts.length) return null
      const objects = await packGitObjects(
        directory,
        [input.pack.sha, tree],
        input.pack.base ?? null,
      )
      return {
        staged: {
          pack: { ...input.pack, objects },
          tree,
        },
        paths: [
          ...new Set([
            ...paths.map(rootRelative),
            ...conflicts.map((conflict) => conflict.path),
          ]),
        ],
        conflicts,
      }
    },
    input.pack,
    input.read,
  )
}

/** Apply only validated conflict resolutions while retaining Git's clean merged changes. */
export async function resolveGitMergeTree(
  merged: GitMergeResult,
  files: readonly { path: string; content: string | null }[],
  read: GitRemoteRead | null,
): Promise<StagedGitTree> {
  const parent = merged.staged.pack.sha
  const candidate = await commitGitTree(
    merged.staged,
    {
      subject: "Unpublished semantic merge tree",
      createdAt: "2000-01-01T00:00:00.000Z",
    },
    read,
  )
  const staged = await stageGitFiles(
    candidate,
    files.flatMap((file) =>
      file.content === null ? [] : [{ path: file.path, content: file.content }],
    ),
    files.filter((file) => file.content === null).map((file) => file.path),
    read,
  )
  return { ...staged, pack: { ...staged.pack, sha: parent } }
}

/**
 * Keep both versions of a conflicting file when no resolution is available
 * (CTX-958). Git marks each overlapping hunk with conflict markers and merges
 * the other lines, so a person or an agent can finish the merge later. Markers
 * cannot show a delete/modify conflict, so that conflict throws: a clean file
 * of one side would lose the other side with no notice.
 */
export async function markGitConflict(
  conflict: GitMergeConflict,
): Promise<string> {
  if (conflict.current === null || conflict.incoming === null)
    throw new Error(
      `Semantic merge could not merge ${conflict.path}: one side deleted the file and the other side changed it. Keep or delete the file on the default branch, then send the write again.`,
    )
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-merge-file-"))
  try {
    await writeFile(join(directory, "current"), conflict.current)
    await writeFile(join(directory, "base"), conflict.base ?? "")
    await writeFile(join(directory, "incoming"), conflict.incoming)
    const merged = await nativeGit(directory, [
      "merge-file",
      "-p",
      "-L",
      "default branch",
      "-L",
      "base",
      "-L",
      "ctxpipe write (the merge model gave no answer; keep the correct lines and remove these markers)",
      "current",
      "base",
      "incoming",
    ]).catch((error: unknown) => {
      // `git merge-file` exits with the count of conflicts (1 to 127) and
      // prints the marked file.
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "number" &&
        error.code > 0 &&
        error.code < 128 &&
        "stdout" in error &&
        Buffer.isBuffer(error.stdout)
      )
        return error.stdout
      throw error
    })
    return merged.toString("utf8")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
