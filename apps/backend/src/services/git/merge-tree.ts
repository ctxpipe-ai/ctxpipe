import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { GitFileChange } from "./file-change.js"
import {
  type GitPack,
  type GitRemoteRead,
  type GitWriteCommit,
  nativeGit,
  type PublishGitCommit,
  withGitDirectory,
} from "./pack.js"
import { workspaceRelativePath } from "./root-folder.js"
import {
  changedRootPaths,
  commitGitTreeIn,
  stageGitTree,
} from "./write-tree.js"

export type GitMergeConflict = {
  path: string
  base: string | null
  current: string | null
  incoming: string | null
}

/**
 * Rebase an unpushed file command onto the tip `pack` with Git's native
 * three-way tree merge, resolve the conflicts with `resolve`, and commit and
 * publish the result in one Git directory (CTX-1235). `pack` must also read
 * `previousSha`. Null when the merge changes nothing. Only a conflict path
 * may take a resolution, and only a path that the merge changes may differ
 * from the tip.
 */
export async function prepareGitMerge(input: {
  pack: GitPack
  previousSha: string
  files: readonly GitFileChange[]
  deletePaths: readonly string[]
  resolve: (
    conflicts: GitMergeConflict[],
  ) => Promise<ReadonlyArray<{ path: string; content: string | null }>>
  subject: string
  createdAt: Date | string
  read: GitRemoteRead | null
  publish: PublishGitCommit
}): Promise<GitWriteCommit | null> {
  const root = input.pack.root ?? ""
  const tip = input.pack.sha
  // Paths in the result are relative to the Workspace root folder.
  const rootRelative = (path: string) => {
    const relative = workspaceRelativePath(root, path)
    if (relative === null)
      throw new Error(
        "The merge changes a path outside the Workspace root folder",
      )
    return relative
  }
  return withGitDirectory(
    tip,
    async (directory) => {
      // This unreachable commit gives merge-tree an identity for the captured command.
      const candidate = await commitGitTreeIn(directory, {
        tree: await stageGitTree(directory, {
          from: input.previousSha,
          root,
          files: input.files,
          deletePaths: input.deletePaths,
        }),
        parents: [input.previousSha],
        subject: "Captured unpushed workspace change",
        createdAt: "2000-01-01T00:00:00.000Z",
      })
      let conflicted = false
      const output = await nativeGit(directory, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        `--merge-base=${input.previousSha}`,
        tip,
        candidate,
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
      const merged = entries.shift()?.trim()
      if (!merged || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(merged))
        throw new Error("Native merge did not produce a tree")
      const paths = await changedRootPaths(directory, {
        root,
        from: tip,
        to: merged,
      })
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
            current: await read(tip, path),
            incoming: await read(candidate, path),
          })
        }
        if (!conflicts.length)
          throw new Error("Native merge conflict has no file paths")
      }
      if (!paths.length && !conflicts.length) return null
      const allowed = new Set([
        ...paths,
        ...conflicts.map((conflict) => conflict.path),
      ])
      let tree = merged
      if (conflicts.length) {
        const resolved = await input.resolve(conflicts)
        tree = await stageGitTree(directory, {
          from: merged,
          root,
          files: resolved.flatMap((file) =>
            file.content === null
              ? []
              : [{ path: file.path, content: file.content }],
          ),
          deletePaths: resolved
            .filter((file) => file.content === null)
            .map((file) => file.path),
        })
      }
      const changed = await changedRootPaths(directory, {
        root,
        from: tip,
        to: tree,
      })
      if (changed.some((path) => !allowed.has(path)))
        throw new Error("Invalid write tree")
      if (!changed.length) return null
      const sha = await commitGitTreeIn(directory, {
        tree,
        parents: [tip],
        subject: input.subject,
        createdAt: input.createdAt,
      })
      await input.publish(directory, sha)
      return { sha, tree, ...(root ? { root } : {}), base: tip }
    },
    input.pack,
    input.read,
  )
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
