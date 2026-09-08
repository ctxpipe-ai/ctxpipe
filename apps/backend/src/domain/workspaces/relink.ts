import type { WorkspaceWriteProbe } from "./write-status.js"

/** A changed remote URL or connection starts a new desired generation. */
export function nextRelinkFields(
  currentGeneration: number,
  write?: WorkspaceWriteProbe,
) {
  return {
    desiredGeneration: currentGeneration + 1,
    desiredSha: null,
    desiredDefaultBranch: null,
    hydrateStatus: "pending",
    hydrateError: null,
    writeStatus: write?.writeStatus ?? "unknown",
    readOnlyReason: write?.readOnlyReason ?? null,
  }
}
