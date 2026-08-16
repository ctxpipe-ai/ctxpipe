export function workspaceProjectionReady(input: {
  hydrateStatus: string
  activeProjectionSha: string | null
}): boolean {
  void input.hydrateStatus
  return Boolean(input.activeProjectionSha)
}

export function workspaceHydrateInFlight(input: {
  hydrateStatus: string
  desiredSha?: string | null
  activeProjectionSha?: string | null
}): boolean {
  if (input.hydrateStatus !== "ready") return true
  if (
    input.desiredSha &&
    input.activeProjectionSha &&
    input.desiredSha !== input.activeProjectionSha
  ) {
    return true
  }
  return false
}
