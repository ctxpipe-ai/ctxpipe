/** Desired SHA follows the resolved remote tip, including rewind. */
export function applyResolvedDesiredSha(resolvedTip: string): string {
  return resolvedTip.trim()
}

export function tipCheckNeedsResolve(
  storedDesiredSha: string | null,
  resolvedTip: string,
): boolean {
  return storedDesiredSha !== applyResolvedDesiredSha(resolvedTip)
}

/** Webhook `after` is a trigger only — never persist it as desired SHA. */
export function shouldPersistWebhookAfterAsDesiredSha(): false {
  return false
}

export function sandboxSnapshotKey(
  desiredUrl: string,
  desiredSha: string | null,
): string | null {
  if (!desiredSha) return null
  return `${desiredUrl}@${desiredSha}`
}

export function shouldActivateHydrateProjection(input: {
  jobGeneration: number
  desiredGeneration: number
  jobWorkspaceUrl: string
  desiredWorkspaceUrl: string
  hydratedSha: string
  desiredSha: string | null
}):
  | { activate: true }
  | {
      activate: false
      reason: "generation" | "url" | "sha" | "desired_sha_missing"
    } {
  if (!input.desiredSha) {
    return { activate: false, reason: "desired_sha_missing" }
  }
  if (input.jobGeneration !== input.desiredGeneration) {
    return { activate: false, reason: "generation" }
  }
  if (input.jobWorkspaceUrl !== input.desiredWorkspaceUrl) {
    return { activate: false, reason: "url" }
  }
  if (input.hydratedSha !== input.desiredSha) {
    return { activate: false, reason: "sha" }
  }
  return { activate: true }
}

export function shouldPublishIndex(input: {
  jobGeneration: number
  desiredGeneration: number
  jobWorkspaceUrl: string
  desiredWorkspaceUrl: string
  jobDesiredSha: string
  currentDesiredSha: string | null
  remoteStillMember: boolean
}):
  | { publish: true }
  | {
      publish: false
      reason: "generation" | "url" | "sha" | "membership"
    } {
  if (!input.remoteStillMember) {
    return { publish: false, reason: "membership" }
  }
  if (input.jobGeneration !== input.desiredGeneration) {
    return { publish: false, reason: "generation" }
  }
  if (input.jobWorkspaceUrl !== input.desiredWorkspaceUrl) {
    return { publish: false, reason: "url" }
  }
  if (input.jobDesiredSha !== input.currentDesiredSha) {
    return { publish: false, reason: "sha" }
  }
  return { publish: true }
}

/** Stale is ok: enqueue the lagging store. Never 503 or roll back hydrate. */
export function reconcileProjectionJobs(input: {
  desiredSha: string | null
  desiredUrl: string
  activeProjectionUrl: string | null
  activeProjectionSha: string | null
  indexedSha: string | null
}): { enqueueHydrate: boolean; enqueueIndex: boolean } {
  if (!input.desiredSha) {
    return { enqueueHydrate: false, enqueueIndex: false }
  }
  const projectionMatches =
    input.activeProjectionUrl === input.desiredUrl &&
    input.activeProjectionSha === input.desiredSha
  return {
    enqueueHydrate: !projectionMatches,
    enqueueIndex: input.indexedSha !== input.desiredSha,
  }
}
