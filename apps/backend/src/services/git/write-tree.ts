import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type GitFileChange, gitFileBytes } from "./file-change.js"

export type { GitFileChange } from "./file-change.js"

import {
  captureGitPack,
  type GitPack,
  nativeGit,
  packGitObjects,
  withGitDirectory,
} from "./pack.js"
import {
  workspaceRelativePath,
  workspaceRepositoryPath,
} from "./root-folder.js"

/** Repository paths below the root folder, mapped to root-relative paths. */
function rootRelativePaths(root: string, paths: readonly string[]): string[] {
  return paths.map((path) => {
    const relative = workspaceRelativePath(root, path)
    if (relative === null)
      throw new Error("The change is outside the Workspace root folder")
    return relative
  })
}

export type StagedGitTree = { pack: GitPack; tree: string }

/**
 * Stage a native tree; all returned objects survive loss of this worker's
 * files. Paths are relative to the pack's root folder.
 */
export async function stageGitFiles(
  pack: GitPack,
  rootFiles: readonly GitFileChange[],
  rootDeletePaths: readonly string[] = [],
): Promise<StagedGitTree> {
  const root = pack.root ?? ""
  const files = rootFiles.map((file) => ({
    ...file,
    path: workspaceRepositoryPath(root, file.path),
  }))
  const deletePaths = rootDeletePaths.map((path) =>
    workspaceRepositoryPath(root, path),
  )
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
      const entries = files.map((file) => {
        const mode = file.mode ?? modes.get(file.path) ?? "100644"
        if (!["100644", "100755", "120000"].includes(mode))
          throw new Error("File edits cannot replace a Git submodule")
        return { mode, file }
      })
      // Two Git processes in total, not two per file: a large capture writes thousands of files.
      const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-stage-"))
      try {
        const paths = await Promise.all(
          files.map(async (file, index) => {
            const path = join(scratch, String(index))
            await writeFile(path, gitFileBytes(file))
            return path
          }),
        )
        const blobs = files.length
          ? (
              await nativeGit(
                directory,
                ["hash-object", "-w", "--no-filters", "--stdin-paths"],
                `${paths.join("\n")}\n`,
              )
            )
              .toString()
              .trim()
              .split("\n")
          : []
        if (entries.length)
          await nativeGit(
            directory,
            ["update-index", "-z", "--index-info"],
            entries
              .map(
                ({ mode, file }, index) =>
                  `${mode} ${blobs[index]}\t${file.path}\0`,
              )
              .join(""),
          )
      } finally {
        await rm(scratch, { recursive: true, force: true })
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
      const objects = await packGitObjects(directory, [pack.sha, tree])
      return { pack: { ...pack, objects }, tree }
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
      const relative = rootRelativePaths(staged.pack.root ?? "", changed)
      if (
        (!options.allowNoChanges && !relative.length) ||
        relative.some((path) => !allowedPaths.includes(path))
      )
        throw new Error("Invalid write tree")
      return relative
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
      const committed = await captureGitPack(directory, sha)
      return staged.pack.root
        ? { ...committed, root: staged.pack.root }
        : committed
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
      const root = pack.root ?? ""
      const relative = rootRelativePaths(root, changed)
      const files: GitFileChange[] = []
      const deletePaths: string[] = []
      for (const [index, path] of changed.entries()) {
        const rootPath = relative[index] ?? path
        if (!existing.has(path)) deletePaths.push(rootPath)
        else
          files.push({
            path: rootPath,
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
