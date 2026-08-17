export type WorkspaceHydrateView =
  | "waiting_for_tip"
  | "hydrating"
  | "failed"
  | "ready"

export function workspaceProjectionReady(input: {
  hydrateStatus: string
  activeProjectionSha: string | null
}): boolean {
  void input.hydrateStatus
  return Boolean(input.activeProjectionSha)
}

export function workspaceHydrateView(input: {
  hydrateStatus: string
  desiredSha?: string | null
  hydrateError?: string | null
  activeProjectionSha?: string | null
}): WorkspaceHydrateView {
  void input.hydrateError
  if (input.hydrateStatus === "failed") return "failed"
  if (input.hydrateStatus === "ready") {
    if (
      input.desiredSha &&
      input.activeProjectionSha &&
      input.desiredSha !== input.activeProjectionSha
    ) {
      return "hydrating"
    }
    return "ready"
  }
  if (!input.desiredSha) return "waiting_for_tip"
  return "hydrating"
}

export function workspaceHydrateInFlight(input: {
  hydrateStatus: string
  desiredSha?: string | null
  hydrateError?: string | null
  activeProjectionSha?: string | null
}): boolean {
  const view = workspaceHydrateView(input)
  return view === "waiting_for_tip" || view === "hydrating"
}
