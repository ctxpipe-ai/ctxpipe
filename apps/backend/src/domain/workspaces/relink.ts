/** Fields that change when the desired workspace repository URL changes. */
export function nextRelinkFields(currentGeneration: number) {
  return {
    desiredGeneration: currentGeneration + 1,
    desiredSha: null,
    hydrateStatus: "pending",
    writeStatus: "unknown",
    readOnlyReason: null,
  }
}
