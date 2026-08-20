export type WorkspaceHydrateView =
  | "waiting_for_tip"
  | "hydrating"
  | "failed"
  | "ready"

export function workspaceProjectionReady(input: {
  hydrateStatus: string
  activeProjectionSha: string | null
  migrationExportSha?: string | null
  writeStatus?: string | null
}): boolean {
  void input.hydrateStatus
  if (!input.activeProjectionSha) return false
  if (input.writeStatus === "writable") {
    return Boolean(input.migrationExportSha)
  }
  if (input.writeStatus === "read_only" || input.writeStatus === "unknown") {
    return true
  }
  return Boolean(input.migrationExportSha)
}

export function workspaceHydrateView(input: {
  hydrateStatus: string
  desiredSha?: string | null
  hydrateError?: string | null
  activeProjectionSha?: string | null
}): WorkspaceHydrateView {
  if (input.hydrateStatus === "failed") return "failed"
  if (input.hydrateStatus !== "ready" && input.hydrateError) return "failed"
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

export function workspacePrepareNeedsPoll(input: {
  hydrateStatus: string
  desiredSha?: string | null
  hydrateError?: string | null
  activeProjectionSha?: string | null
  migrationExportSha?: string | null
  writeStatus?: string | null
}): boolean {
  if (
    workspaceProjectionReady({
      hydrateStatus: input.hydrateStatus,
      activeProjectionSha: input.activeProjectionSha ?? null,
      migrationExportSha: input.migrationExportSha,
      writeStatus: input.writeStatus,
    })
  ) {
    return workspaceHydrateInFlight(input)
  }
  return workspaceHydrateView(input) !== "failed"
}
