import { z } from "zod"

export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

export const repositoryRemoteSchema = z
  .object({
    url: z.string().min(1),
    connectionId: z.string().min(1).nullable(),
  })
  .readonly()

export const workspaceRevisionSchema = z
  .object({
    workspaceId: z.string().min(1),
    generation: z.number().int().positive(),
    remote: repositoryRemoteSchema,
    defaultBranch: z.string().min(1),
    sha: gitObjectIdSchema,
    access: z.enum(["read", "publish-session", "write-default"]),
  })
  .readonly()

export type WorkspaceRevision = z.infer<typeof workspaceRevisionSchema>

export const linkedRevisionSchema = z
  .object({
    owner: workspaceRevisionSchema,
    linkId: z.string().min(1),
    repositoryId: z.string().min(1),
    remote: repositoryRemoteSchema,
    ref: z.string().min(1).nullable(),
    sha: gitObjectIdSchema,
  })
  .readonly()

export type LinkedRevision = z.infer<typeof linkedRevisionSchema>
export type LinkedReadBinding = Omit<LinkedRevision, "sha"> & {
  readonly sha: string | null
}

export type DerivedStoreResult =
  | { kind: "pending" }
  | { kind: "ready" }
  | { kind: "failed"; message: string }

export type StoreFreshness = {
  embeddings: DerivedStoreResult
  graph: DerivedStoreResult
  index: DerivedStoreResult & { published?: WorkspaceRevision | null }
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

export function sameWorkspaceBinding(
  a: WorkspaceRevision | null | undefined,
  b: WorkspaceRevision,
): boolean {
  return (
    a?.workspaceId === b.workspaceId &&
    a.generation === b.generation &&
    a.remote.url === b.remote.url &&
    a.remote.connectionId === b.remote.connectionId &&
    a.defaultBranch === b.defaultBranch
  )
}

export function sameWorkspaceRevision(
  a: WorkspaceRevision | null | undefined,
  b: WorkspaceRevision,
): boolean {
  return sameWorkspaceBinding(a, b) && a?.sha === b.sha && a.access === b.access
}

export function publishedProjection(
  state: ProjectionState,
): PublishedProjection | null {
  if (state.kind === "active" || state.kind === "legacy") return state
  if (state.kind === "building" || state.kind === "failed")
    return state.previous
  return null
}

/** Legacy chat runtime key; Gate 4 removes this caller during native sandbox adoption. */
export function sandboxSnapshotKey(
  desiredUrl: string,
  desiredSha: string | null,
): string | null {
  if (!desiredSha) return null
  return `${desiredUrl}@${desiredSha}`
}

export function sameLinkedReadBinding(
  a: LinkedReadBinding | null,
  b: LinkedReadBinding,
): boolean {
  return Boolean(
    a &&
      sameWorkspaceRevision(a.owner, b.owner) &&
      a.linkId === b.linkId &&
      a.repositoryId === b.repositoryId &&
      a.remote.url === b.remote.url &&
      a.remote.connectionId === b.remote.connectionId &&
      a.ref === b.ref &&
      a.sha === b.sha,
  )
}
