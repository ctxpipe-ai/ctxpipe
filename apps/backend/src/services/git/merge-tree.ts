import type { GitFileChange } from "./file-change.js"
import { type GitPack, nativeGit, withGitDirectory } from "./pack.js"
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

export type GitMergeResult = {
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
}): Promise<GitMergeResult | null> {
  const candidateTree = await stageGitFiles(
    { ...input.pack, sha: input.previousSha },
    input.files,
    input.deletePaths,
  )
  // This unreachable object gives merge-tree a commit identity for the captured command.
  const candidate = await commitGitTree(candidateTree, {
    subject: "Captured unpushed workspace change",
    createdAt: "2000-01-01T00:00:00.000Z",
  })
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
            path,
            base: await read(input.previousSha, path),
            current: await read(input.pack.sha, path),
            incoming: await read(candidate.sha, path),
          })
        }
        if (!conflicts.length)
          throw new Error("Native merge conflict has no file paths")
      }
      if (!paths.length && !conflicts.length) return null
      const objects = await nativeGit(
        directory,
        ["pack-objects", "--stdout", "--revs"],
        `${input.pack.sha}\n${tree}\n`,
      )
      return {
        staged: {
          pack: { ...input.pack, objects: objects.toString("base64") },
          tree,
        },
        paths,
        conflicts,
      }
    },
    input.pack,
  )
}

/** Apply only validated conflict resolutions while retaining Git's clean merged changes. */
export async function resolveGitMergeTree(
  merged: GitMergeResult,
  files: readonly { path: string; content: string | null }[],
): Promise<StagedGitTree> {
  const parent = merged.staged.pack.sha
  const candidate = await commitGitTree(merged.staged, {
    subject: "Unpublished semantic merge tree",
    createdAt: "2000-01-01T00:00:00.000Z",
  })
  const staged = await stageGitFiles(
    candidate,
    files.flatMap((file) =>
      file.content === null ? [] : [{ path: file.path, content: file.content }],
    ),
    files.filter((file) => file.content === null).map((file) => file.path),
  )
  return { ...staged, pack: { ...staged.pack, sha: parent } }
}
