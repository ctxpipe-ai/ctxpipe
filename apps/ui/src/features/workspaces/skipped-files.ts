import type { WorkspaceSkippedFile } from "./types"

/** Why hydrate skipped a file, in plain words. */
const skippedReasonCopy: Record<WorkspaceSkippedFile["reason"], string> = {
  malformed: "Front matter is not valid",
  duplicate_repository:
    "Repeats a linked repository or the Workspace's own repository",
  merge_conflict:
    "This file has unresolved merge markers. Keep the right version and remove the markers.",
}

/** What the agent must do for each cause that it can fix, for one file. */
const fixInstruction: Partial<Record<WorkspaceSkippedFile["reason"], string>> =
  {
    malformed: "Fix the front matter of this file so that it is valid",
    merge_conflict:
      "Keep the right version of each marked part of this file and remove the markers",
  }

/**
 * Why hydrate skipped one file, with its cause. A legacy overlay file is not
 * in Git: ctxpipe builds it from its database, so no edit of the Workspace
 * repository fixes it.
 */
export function skippedFileCopy(file: WorkspaceSkippedFile): string {
  return file.source === "legacy-overlay"
    ? "Knowledge from before Workspaces. ctxpipe shows it from its database, so it cannot be fixed here."
    : skippedReasonCopy[file.reason]
}

/**
 * Only front matter or merge markers in a file of Git are for the agent to
 * fix.
 */
export function skippedFileFixable(file: WorkspaceSkippedFile): boolean {
  return (
    fixInstruction[file.reason] !== undefined &&
    file.source !== "legacy-overlay"
  )
}

/**
 * The chat prompt that asks the agent to fix skipped files. Give it only
 * files that `skippedFileFixable` accepts.
 */
export function skippedFilesFixPrompt(
  files: readonly WorkspaceSkippedFile[],
): string {
  const [only] = files
  if (only && files.length === 1)
    return `Hydrate skipped ${only.path}: ${skippedFileCopy(only).replace(/\.$/, "")}. ${fixInstruction[only.reason]}, then open the change.`
  const list = files
    .map((file) => `${file.path} (${skippedFileCopy(file)})`)
    .join(", ")
  return `Hydrate skipped these files: ${list}. Fix each file as its cause says, then open the change.`
}
