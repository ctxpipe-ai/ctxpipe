import { z } from "zod"

export const workspaceRevisionSchema = z
  .object({
    workspaceId: z.string().min(1),
    generation: z.number().int().positive(),
    remote: z
      .object({
        url: z.string().min(1),
        githubConnectionId: z.string().min(1).nullable(),
      })
      .readonly(),
    defaultBranch: z.string().min(1),
    sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    access: z.enum(["read", "publish-session", "write-default"]),
  })
  .readonly()

export type WorkspaceRevision = z.infer<typeof workspaceRevisionSchema>

export type DerivedStoreResult =
  | { kind: "pending" }
  | { kind: "ready" }
  | { kind: "failed"; message: string }

export type StoreFreshness = {
  embeddings: DerivedStoreResult
  graph: { kind: "postgres" }
  index: DerivedStoreResult
}

export type PublishedProjection =
  | { kind: "active"; revision: WorkspaceRevision; stores: StoreFreshness }
  | { kind: "legacy"; url: string | null; sha: string }

export type ProjectionState =
  | PublishedProjection
  | { kind: "absent" }
  | {
      kind: "building"
      desired: WorkspaceRevision | null
      previous: PublishedProjection | null
    }
  | {
      kind: "failed"
      desired: WorkspaceRevision | null
      previous: PublishedProjection | null
      error: string
    }

export function sameWorkspaceRevision(
  a: WorkspaceRevision | null | undefined,
  b: WorkspaceRevision,
): boolean {
  return (
    a?.workspaceId === b.workspaceId &&
    a.generation === b.generation &&
    a.remote.url === b.remote.url &&
    a.remote.githubConnectionId === b.remote.githubConnectionId &&
    a.defaultBranch === b.defaultBranch &&
    a.sha === b.sha &&
    a.access === b.access
  )
}

export function publishedProjection(
  state: ProjectionState,
): PublishedProjection | null {
  if (state.kind === "active" || state.kind === "legacy") return state
  if (state.kind === "building" || state.kind === "failed")
    return state.previous
  return null
}

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
  jobWorkspaceId: string
  desiredWorkspaceId: string
  hydratedSha: string
  desiredSha: string | null
}):
  | { activate: true }
  | {
      activate: false
      reason: "generation" | "url" | "sha" | "workspace" | "desired_sha_missing"
    } {
  if (!input.desiredSha) {
    return { activate: false, reason: "desired_sha_missing" }
  }
  if (input.jobWorkspaceId !== input.desiredWorkspaceId) {
    return { activate: false, reason: "workspace" }
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

export function workspaceIndexJobs(input: {
  workspaceId: string
  workspaceRepositoryUrl: string
  desiredGeneration: number
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
  jobGeneration: number
  jobWorkspaceUrl: string
}> {
  const jobs: Array<{
    workspaceId: string
    gitUrl: string
    desiredSha: string
    role: "workspace" | "linked"
    linkedId?: string
    jobGeneration: number
    jobWorkspaceUrl: string
  }> = []
  if (input.desiredSha && input.indexedSha !== input.desiredSha) {
    jobs.push({
      workspaceId: input.workspaceId,
      gitUrl: input.workspaceRepositoryUrl,
      desiredSha: input.desiredSha,
      role: "workspace",
      jobGeneration: input.desiredGeneration,
      jobWorkspaceUrl: input.workspaceRepositoryUrl,
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
      jobGeneration: input.desiredGeneration,
      jobWorkspaceUrl: input.workspaceRepositoryUrl,
    })
  }
  return jobs
}

/** Compare published identities without interpreting derived-store freshness as identity. */
export function samePublishedProjection(
  left: PublishedProjection | null,
  right: PublishedProjection | null,
): boolean {
  if (left?.kind === "active" && right?.kind === "active")
    return sameWorkspaceRevision(left.revision, right.revision)
  return (
    left?.kind === "legacy" &&
    right?.kind === "legacy" &&
    left.url === right.url &&
    left.sha === right.sha
  )
}
