import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type GitFileChange, gitFileBytes } from "./file-change.js"

export type { GitFileChange } from "./file-change.js"

import {
  captureGitPack,
  type GitPack,
  type GitRemoteRead,
  type GitWriteCommit,
  nativeGit,
  packGitObjects,
  type PublishGitCommit,
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

/**
 * Stage root-relative changes onto the tree `from` in the index of
 * `directory`, and write the tree. Two Git processes write the blobs, not two
 * per file: a large capture writes thousands of files.
 */
export async function stageGitTree(
  directory: string,
  input: {
    from: string
    root: string
    files: readonly GitFileChange[]
    deletePaths: readonly string[]
  },
): Promise<string> {
  const files = input.files.map((file) => ({
    ...file,
    path: workspaceRepositoryPath(input.root, file.path),
  }))
  const deletePaths = input.deletePaths.map((path) =>
    workspaceRepositoryPath(input.root, path),
  )
  await nativeGit(directory, ["read-tree", input.from])
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
    await nativeGit(directory, ["update-index", "--force-remove", "--", path])
  return (await nativeGit(directory, ["write-tree"])).toString().trim()
}

/** The root-relative paths that differ between two trees. */
export async function changedRootPaths(
  directory: string,
  input: { root: string; from: string; to: string },
): Promise<string[]> {
  const changed = (
    await nativeGit(directory, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      input.from,
      input.to,
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean)
  return rootRelativePaths(input.root, changed)
}

/** A fixed tree, parents, subject, and timestamp reproduce exactly the same commit. */
export async function commitGitTreeIn(
  directory: string,
  input: {
    tree: string
    parents: readonly string[]
    subject: string
    createdAt: Date | string
  },
): Promise<string> {
  const date = new Date(input.createdAt).toISOString()
  return (
    await nativeGit(
      directory,
      ["commit-tree", input.tree, ...input.parents.flatMap((p) => ["-p", p])],
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
}

/**
 * Stage, check, and commit file changes on `pack` in one Git directory, and
 * publish the commit before the directory goes away (CTX-1235). The result
 * holds no Git object: a later step fetches the commit from the Git host.
 * Paths are relative to the pack's root folder. Each path that changes must
 * be a path of the change, and the change must change a path.
 */
export async function prepareGitCommit(input: {
  pack: GitPack
  files: readonly GitFileChange[]
  deletePaths: readonly string[]
  subject: string
  createdAt: Date | string
  read: GitRemoteRead | null
  publish: PublishGitCommit
}): Promise<GitWriteCommit> {
  const root = input.pack.root ?? ""
  const allowed = new Set([
    ...input.files.map((file) => file.path),
    ...input.deletePaths,
  ])
  return withGitDirectory(
    input.pack.sha,
    async (directory) => {
      const tree = await stageGitTree(directory, {
        from: input.pack.sha,
        root,
        files: input.files,
        deletePaths: input.deletePaths,
      })
      const changed = await changedRootPaths(directory, {
        root,
        from: input.pack.sha,
        to: tree,
      })
      if (!changed.length || changed.some((path) => !allowed.has(path)))
        throw new Error("Invalid write tree")
      const sha = await commitGitTreeIn(directory, {
        tree,
        parents: [input.pack.sha],
        subject: input.subject,
        createdAt: input.createdAt,
      })
      await input.publish(directory, sha)
      return { sha, tree, ...(root ? { root } : {}), base: input.pack.sha }
    },
    input.pack,
    input.read,
  )
}

type StagedGitTree = { pack: GitPack; tree: string }

/**
 * Stage a native tree; all returned objects survive loss of this worker's
 * files. Paths are relative to the pack's root folder. The pack is for a
 * caller that keeps it in memory: a durable step uses `prepareGitCommit`.
 */
export async function stageGitFiles(
  pack: GitPack,
  rootFiles: readonly GitFileChange[],
  rootDeletePaths: readonly string[] = [],
  read: GitRemoteRead | null,
): Promise<StagedGitTree> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const tree = await stageGitTree(directory, {
        from: pack.sha,
        root: pack.root ?? "",
        files: rootFiles,
        deletePaths: rootDeletePaths,
      })
      const objects = await packGitObjects(
        directory,
        [pack.sha, tree],
        pack.base ?? null,
      )
      return { pack: { ...pack, objects }, tree }
    },
    pack,
    read,
  )
}

export async function validateGitTree(
  staged: StagedGitTree,
  allowedPaths: readonly string[],
  options: { allowNoChanges?: boolean } = {},
  read: GitRemoteRead | null,
): Promise<string[]> {
  return withGitDirectory(
    staged.pack.sha,
    async (directory) => {
      const relative = await changedRootPaths(directory, {
        root: staged.pack.root ?? "",
        from: staged.pack.sha,
        to: staged.tree,
      })
      if (
        (!options.allowNoChanges && !relative.length) ||
        relative.some((path) => !allowedPaths.includes(path))
      )
        throw new Error("Invalid write tree")
      return relative
    },
    staged.pack,
    read,
  )
}

/** A fixed tree, parent, subject, and timestamp reproduce exactly the same commit. */
export async function commitGitTree(
  staged: StagedGitTree,
  input: { subject: string; createdAt: Date | string },
  read: GitRemoteRead | null,
): Promise<GitPack> {
  return withGitDirectory(
    staged.pack.sha,
    async (directory) => {
      const sha = await commitGitTreeIn(directory, {
        tree: staged.tree,
        parents: [staged.pack.sha],
        ...input,
      })
      const committed = await captureGitPack(
        directory,
        sha,
        staged.pack.base ?? null,
      )
      return staged.pack.root
        ? { ...committed, root: staged.pack.root }
        : committed
    },
    staged.pack,
    read,
  )
}

/** Exact native delta for semantic handoff, including binary bytes and removals. */
export async function readGitCommitChanges(
  pack: GitPack,
  parent: string,
  read: GitRemoteRead | null,
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
    read,
  )
}
