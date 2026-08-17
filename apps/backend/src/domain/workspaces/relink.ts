import type { WorkspaceWriteProbe } from "./write-status.js"

/** Fields that change when the desired workspace repository URL changes. */
export function nextRelinkFields(
  currentGeneration: number,
  write?: WorkspaceWriteProbe,
) {
  return {
    desiredGeneration: currentGeneration + 1,
    desiredSha: null,
    hydrateStatus: "pending",
    hydrateError: null,
    writeStatus: write?.writeStatus ?? "unknown",
    readOnlyReason: write?.readOnlyReason ?? null,
  }
}
