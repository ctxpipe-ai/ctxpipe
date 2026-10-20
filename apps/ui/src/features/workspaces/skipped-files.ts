import type { WorkspaceSkippedFile } from "./types"

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
