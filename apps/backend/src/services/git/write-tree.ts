import { type GitFileChange, gitFileBytes } from "./file-change.js"

export type { GitFileChange } from "./file-change.js"

import {
  captureGitPack,
  type GitPack,
  nativeGit,
  withGitDirectory,
} from "./pack.js"

export type StagedGitTree = { pack: GitPack; tree: string }

/** Stage a native tree; all returned objects survive loss of this worker's files. */
export async function stageGitFiles(
  pack: GitPack,
  files: readonly GitFileChange[],
  deletePaths: readonly string[] = [],
): Promise<StagedGitTree> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const modes = new Map(
        (await nativeGit(directory, ["ls-files", "--stage", "-z"]))
          .toString()
          .split("\0")
          .filter(Boolean)
          .map((entry) => {
            const tab = entry.indexOf("\t")
            return [entry.slice(tab + 1), entry.slice(0, 6)]
          }),
      )
      for (const file of files) {
        const mode = modes.get(file.path) ?? "100644"
        if (!["100644", "100755", "120000"].includes(mode))
          throw new Error("File edits cannot replace a Git submodule")
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
          `${mode},${blob},${file.path}`,
        ])
      }
      for (const path of deletePaths)
        await nativeGit(directory, [
          "update-index",
          "--force-remove",
          "--",
          path,
        ])
      const tree = (await nativeGit(directory, ["write-tree"]))
        .toString()
        .trim()
      const objects = await nativeGit(
        directory,
        ["pack-objects", "--stdout", "--revs"],
        `${pack.sha}\n${tree}\n`,
      )
      return { pack: { ...pack, objects: objects.toString("base64") }, tree }
    },
    pack,
  )
}

export async function validateGitTree(
  staged: StagedGitTree,
  allowedPaths: readonly string[],
  options: { allowNoChanges?: boolean } = {},
): Promise<string[]> {
  return withGitDirectory(
    staged.pack.sha,
    async (directory) => {
      const changed = (
        await nativeGit(directory, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          staged.pack.sha,
          staged.tree,
        ])
      )
        .toString()
        .split("\0")
        .filter(Boolean)
      if (
        (!options.allowNoChanges && !changed.length) ||
        changed.some((path) => !allowedPaths.includes(path))
      )
        throw new Error("Invalid write tree")
      return changed
    },
    staged.pack,
  )
}

/** A fixed tree, parent, subject, and timestamp reproduce exactly the same commit. */
export async function commitGitTree(
  staged: StagedGitTree,
  input: { subject: string; createdAt: Date | string },
): Promise<GitPack> {
  return withGitDirectory(
    staged.pack.sha,
    async (directory) => {
      const date = new Date(input.createdAt).toISOString()
      const sha = (
        await nativeGit(
          directory,
          ["commit-tree", staged.tree, "-p", staged.pack.sha],
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
    },
    staged.pack,
  )
}

/** Exact native delta for semantic handoff, including binary bytes and removals. */
export async function readGitCommitChanges(
  pack: GitPack,
  parent: string,
): Promise<{ files: GitFileChange[]; deletePaths: string[] }> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const changed = (
        await nativeGit(directory, [
          "diff-tree",
          "--no-commit-id",
          "--no-renames",
          "--name-only",
          "-r",
          "-z",
          parent,
          pack.sha,
        ])
      )
        .toString()
        .split("\0")
        .filter(Boolean)
      const existing = new Set(
        (
          await nativeGit(directory, [
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            pack.sha,
          ])
        )
          .toString()
          .split("\0"),
      )
      const files: GitFileChange[] = []
      const deletePaths: string[] = []
      for (const path of changed) {
        if (!existing.has(path)) deletePaths.push(path)
        else
          files.push({
            path,
            content: (
              await nativeGit(directory, ["show", `${pack.sha}:${path}`])
            ).toString("base64"),
            encoding: "base64",
          })
      }
      return { files, deletePaths }
    },
    pack,
  )
}
