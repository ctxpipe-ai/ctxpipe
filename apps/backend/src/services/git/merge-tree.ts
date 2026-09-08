import type { GitFileChange } from "./file-change.js"
import { type GitPack, nativeGit, withGitDirectory } from "./pack.js"
import {
  commitGitTree,
  type StagedGitTree,
  stageGitFiles,
} from "./write-tree.js"

/** Rebase an unpushed file command using Git's native three-way tree merge. */
export async function mergeGitFiles(input: {
  pack: GitPack
  previousSha: string
  files: readonly GitFileChange[]
  deletePaths: readonly string[]
}): Promise<{ staged: StagedGitTree; paths: string[] } | null> {
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
      const output = await nativeGit(directory, [
        "merge-tree",
        "--write-tree",
        `--merge-base=${input.previousSha}`,
        input.pack.sha,
        candidate.sha,
      ])
      const tree = output.toString().split("\n")[0]?.trim()
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
      if (!paths.length) return null
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
      }
    },
    input.pack,
  )
}
