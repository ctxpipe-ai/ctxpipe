import {
  captureGitPack,
  type GitPack,
  nativeGit,
  withGitDirectory,
} from "./pack.js"

export type GitFileChange = { path: string; content: string }
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
            file.content,
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
): Promise<void> {
  await withGitDirectory(
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
        !changed.length ||
        changed.some((path) => !allowedPaths.includes(path))
      )
        throw new Error("Invalid write tree")
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
