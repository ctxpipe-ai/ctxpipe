export function isDefaultBranchPush(
  ref: string,
  defaultBranch: string,
): boolean {
  return ref === `refs/heads/${defaultBranch}`
}

export function shouldEnqueueCronHydrate(input: {
  migrationExportSha: string | null | undefined
  desiredSha?: string | null
  activeProjectionSha?: string | null
  writeStatus?: string | null
}): boolean {
  if (!input.desiredSha) return false
  const skipExportWait =
    input.writeStatus === "read_only" || input.writeStatus === "unknown"
  if (!skipExportWait && !input.migrationExportSha) return false
  return input.desiredSha !== input.activeProjectionSha
}
