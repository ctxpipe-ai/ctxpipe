import type { WorkspaceSkippedFile } from "./types"

/** Why hydrate skipped a file, in plain words. */
const skippedReasonCopy: Record<WorkspaceSkippedFile["reason"], string> = {
  malformed: "Front matter is not valid",
  duplicate_repository:
    "Repeats a linked repository or the Workspace's own repository",
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

/** Only front matter in a file of Git is for the agent to fix. */
export function skippedFileFixable(file: WorkspaceSkippedFile): boolean {
  return file.reason === "malformed" && file.source !== "legacy-overlay"
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
    return `Hydrate skipped ${only.path}: ${skippedFileCopy(only)}. Fix the front matter of this file so that it is valid, then open the change.`
  const list = files
    .map((file) => `${file.path} (${skippedFileCopy(file)})`)
    .join(", ")
  return `Hydrate skipped these files: ${list}. Fix the front matter of each file so that it is valid, then open the change.`
}
