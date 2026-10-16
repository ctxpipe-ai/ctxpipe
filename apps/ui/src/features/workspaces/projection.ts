import type { WorkspaceStorePhase } from "./types"

export type WorkspaceHydrateView =
  | "waiting_for_tip"
  | "hydrating"
  | "failed"
  | "ready"

export function workspaceProjectionReady(input: {
  hydrateStatus: string
  activeProjectionSha: string | null
  writeStatus?: string | null
}): boolean {
  void input.hydrateStatus
  void input.writeStatus
  return Boolean(input.activeProjectionSha)
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
  writeStatus?: string | null
  readOnlyReason?: string | null
  hydratePhases?: { graph: WorkspaceStorePhase }
}): boolean {
  if (
    workspaceProjectionReady({
      hydrateStatus: input.hydrateStatus,
      activeProjectionSha: input.activeProjectionSha ?? null,
      writeStatus: input.writeStatus,
    })
  ) {
    return (
      workspaceHydrateInFlight(input) ||
      writeCheckInFlight(input) ||
      input.hydratePhases?.graph.kind === "pending"
    )
  }
  return workspaceHydrateView(input) !== "failed"
}

/**
 * A write-access check is in progress. `unknown` with a reason is a failed
 * check: the backend stops there, so the UI stops its poll.
 */
export function writeCheckInFlight(input: {
  writeStatus?: string | null
  readOnlyReason?: string | null
}): boolean {
  return input.writeStatus === "unknown" && !input.readOnlyReason
}

/** The poll for a running write-access check stops after this time. */
export const WRITE_CHECK_POLL_CAP_MS = 3 * 60_000
