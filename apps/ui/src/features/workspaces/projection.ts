export function workspaceProjectionReady(input: {
  hydrateStatus: string
  activeProjectionSha: string | null
}): boolean {
  return input.hydrateStatus === "ready" && Boolean(input.activeProjectionSha)
}
