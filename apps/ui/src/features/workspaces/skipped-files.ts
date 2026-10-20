import type { WorkspaceDetail, WorkspaceSkippedFile } from "./types"

/** Why hydrate skipped a file, in plain words. */
export const skippedReasonCopy: Record<WorkspaceSkippedFile["reason"], string> =
  {
    malformed: "Front matter is not valid",
    duplicate_repository:
      "Repeats a linked repository or the Workspace's own repository",
  }

/**
 * The chat prompt that asks the agent to fix skipped files. Only front
 * matter is for the agent to fix, so give it only `malformed` files.
 */
export function skippedFilesFixPrompt(
  files: readonly WorkspaceSkippedFile[],
): string {
  const [only] = files
  if (only && files.length === 1)
    return `Hydrate skipped ${only.path}: ${skippedReasonCopy[only.reason]}. Fix the front matter of this file so that it is valid, then open the change.`
  const list = files
    .map((file) => `${file.path} (${skippedReasonCopy[file.reason]})`)
    .join(", ")
  return `Hydrate skipped these files: ${list}. Fix the front matter of each file so that it is valid, then open the change.`
}

/**
 * The skipped files that the current tree of the default branch holds.
 * `fixable` names the files that the chat checkout contains and that the
 * agent can fix (front matter). With no tree (not read yet, or it failed)
 * nothing is known: every file stays listed, none is fixable, and `checked`
 * is false.
 */
export function skippedFilesInTree(
  files: readonly WorkspaceSkippedFile[],
  treePaths: readonly string[] | undefined,
): {
  files: WorkspaceSkippedFile[]
  fixable: ReadonlySet<string>
  checked: boolean
} {
  if (!treePaths?.length)
    return { files: [...files], fixable: new Set(), checked: false }
  const tree = new Set(treePaths)
  const inTree = files.filter((file) => tree.has(file.path))
  return {
    files: inTree,
    fixable: new Set(
      inTree.filter((file) => file.reason === "malformed").map((f) => f.path),
    ),
    checked: true,
  }
}

/** The SHA of the tree that hydrate read, as the Files pane uses it. */
export function workspaceTreeSha(
  workspace: Pick<WorkspaceDetail, "activeProjectionSha" | "desiredSha">,
): string {
  return (
    workspace.activeProjectionSha?.trim() || workspace.desiredSha?.trim() || ""
  )
}
