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

export type WorkspaceIndexTarget = {
  workspaceId: string
  role: "workspace" | "linked"
  linkedId?: string
  expectedGeneration: number
  expectedUrl: string
  expectedLinkedUrl?: string
  expectedLinkedRef?: string | null
  expectedDesiredSha: string
}

/** Which Workspace / linked rows may publish this codesearch SHA. */
export function indexPublishTargets(input: {
  gitUrl: string
  indexedSha: string
  normalizeUrl: (url: string) => string
  workspaces: ReadonlyArray<{
    id: string
    workspaceRepositoryUrl: string
    desiredGeneration: number
    desiredSha: string | null
  }>
  linked: ReadonlyArray<{
    id: string
    workspaceId: string
    gitUrl: string
    desiredSha: string | null
    desiredRef?: string | null
    desiredGeneration: number
    workspaceUrl: string
  }>
}): WorkspaceIndexTarget[] {
  const gitUrl = input.normalizeUrl(input.gitUrl)
  const targets: WorkspaceIndexTarget[] = []
  for (const workspace of input.workspaces) {
    const url = input.normalizeUrl(workspace.workspaceRepositoryUrl)
    const decision = shouldPublishIndex({
      jobGeneration: workspace.desiredGeneration,
      desiredGeneration: workspace.desiredGeneration,
      jobWorkspaceUrl: url,
      desiredWorkspaceUrl: url,
      jobDesiredSha: input.indexedSha,
      currentDesiredSha: workspace.desiredSha,
      remoteStillMember: url === gitUrl,
    })
    if (!decision.publish) continue
    targets.push({
      workspaceId: workspace.id,
      role: "workspace",
      expectedGeneration: workspace.desiredGeneration,
      expectedUrl: workspace.workspaceRepositoryUrl,
      expectedDesiredSha: input.indexedSha,
    })
  }
  for (const row of input.linked) {
    const url = input.normalizeUrl(row.gitUrl)
    const workspaceUrl = input.normalizeUrl(row.workspaceUrl)
    const decision = shouldPublishIndex({
      jobGeneration: row.desiredGeneration,
      desiredGeneration: row.desiredGeneration,
      jobWorkspaceUrl: workspaceUrl,
      desiredWorkspaceUrl: workspaceUrl,
      jobDesiredSha: input.indexedSha,
      currentDesiredSha: row.desiredSha,
      remoteStillMember: url === gitUrl,
    })
    if (!decision.publish) continue
    targets.push({
      workspaceId: row.workspaceId,
      role: "linked",
      linkedId: row.id,
      expectedGeneration: row.desiredGeneration,
      expectedUrl: row.workspaceUrl,
      expectedLinkedUrl: row.gitUrl,
      expectedLinkedRef: row.desiredRef ?? null,
      expectedDesiredSha: input.indexedSha,
    })
  }
  return targets
}

export function workspaceIndexJobs(input: {
  workspaceId: string
  workspaceRepositoryUrl: string
  desiredSha: string | null
  indexedSha: string | null
  linked: ReadonlyArray<{
    id: string
    gitUrl: string
    desiredSha: string | null
    indexedSha: string | null
  }>
}): Array<{
  workspaceId: string
  gitUrl: string
  desiredSha: string
  role: "workspace" | "linked"
  linkedId?: string
}> {
  const jobs: Array<{
    workspaceId: string
    gitUrl: string
    desiredSha: string
    role: "workspace" | "linked"
    linkedId?: string
  }> = []
  if (input.desiredSha && input.indexedSha !== input.desiredSha) {
    jobs.push({
      workspaceId: input.workspaceId,
      gitUrl: input.workspaceRepositoryUrl,
      desiredSha: input.desiredSha,
      role: "workspace",
    })
  }
  for (const row of input.linked) {
    if (!row.desiredSha || row.indexedSha === row.desiredSha) continue
    jobs.push({
      workspaceId: input.workspaceId,
      gitUrl: row.gitUrl,
      desiredSha: row.desiredSha,
      role: "linked",
      linkedId: row.id,
    })
  }
  return jobs
}
