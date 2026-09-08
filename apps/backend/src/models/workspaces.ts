import { and, desc, eq, exists, inArray, isNotNull, sql } from "drizzle-orm"
import { createError } from "evlog"
import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  orgFirstWorkspaces,
  orgMemberPreferences,
  workspaceKnowledgeUnits,
  workspaceLinkedRepositories,
  workspaces,
} from "../db/schema/workspaces.js"
import {
  type DestWorkspaceLinkPlan,
  planDestWorkspaceLinks,
} from "../domain/workspaces/dest-workspace-assignment.js"
import type { HydrateUnit } from "../domain/workspaces/hydrate.js"
import { initialHydratePhases } from "../domain/workspaces/hydrate-phases.js"
import { nextRelinkFields } from "../domain/workspaces/relink.js"
import {
  applyResolvedDesiredSha,
  type DerivedStoreResult,
  type ProjectionState,
  type PublishedProjection,
  publishedProjection,
  sameWorkspaceRevision,
  shouldPublishIndex,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../domain/workspaces/revision.js"
import {
  displayNameFromGitUrl,
  isValidSlug,
  nextSlugCandidate,
  normalizeSlug,
  normalizeWorkspaceRepositoryUrl,
  slugFromGitUrl,
} from "../domain/workspaces/slug.js"
import {
  type WorkspaceWriteProbe,
  writeStatusFromClassification,
} from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import { isUniqueViolation, orgSql } from "./workspace-sql.js"

/** Transitional wire record; revision consumers use getWorkspaceProjection. */
export type WorkspaceRecord = Omit<
  typeof workspaces.$inferSelect,
  "activeRevision" | "desiredDefaultBranch"
> & {
  activeRevision?: WorkspaceRevision | null
  desiredDefaultBranch?: string | null
}
export type WorkspaceLinkedRepositoryRecord =
  typeof workspaceLinkedRepositories.$inferSelect

export type WorkspaceListItem = WorkspaceRecord & {
  mostRecentConversationId: string | null
}

async function takenSlugs(
  orgId: string,
  excludeWorkspaceId?: string,
): Promise<Set<string>> {
  const db = getOrgDb()
  const rows = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.orgId, orgId))
  return new Set(
    rows
      .filter((row) => row.id !== excludeWorkspaceId)
      .map((row) => row.slug.toLowerCase()),
  )
}

export async function listWorkspaces(): Promise<{
  items: WorkspaceListItem[]
  lastUsedWorkspaceId: string | null
}> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()

    const rows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId))
      .orderBy(workspaces.createdAt, workspaces.id)

    const recent = await db
      .select({
        workspaceId: conversations.workspaceId,
        id: conversations.id,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, orgId),
          eq(conversations.userId, userId),
          sql`${conversations.workspaceId} IS NOT NULL`,
          isNotNull(conversations.lastMessageAt),
        ),
      )
      .orderBy(
        sql`${conversations.lastMessageAt} DESC NULLS LAST`,
        desc(conversations.id),
      )

    const mostRecentByWorkspace = new Map<string, string>()
    for (const row of recent) {
      if (!row.workspaceId) continue
      if (!mostRecentByWorkspace.has(row.workspaceId)) {
        mostRecentByWorkspace.set(row.workspaceId, row.id)
      }
    }

    const [prefs] = await db
      .select()
      .from(orgMemberPreferences)
      .where(
        and(
          eq(orgMemberPreferences.userId, userId),
          eq(orgMemberPreferences.orgId, orgId),
        ),
      )
      .limit(1)

    return {
      lastUsedWorkspaceId: prefs?.lastUsedWorkspaceId ?? null,
      items: rows.map((row) => ({
        ...row,
        mostRecentConversationId: mostRecentByWorkspace.get(row.id) ?? null,
      })),
    }
  })
}

export async function getWorkspaceBySlug(
  slug: string,
): Promise<WorkspaceRecord | null> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const normalised = slug.trim().toLowerCase()
    if (!isValidSlug(normalised)) return null
    const [row] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.slug, normalised)))
      .limit(1)
    return row ?? null
  })
}

export async function getWorkspaceById(
  workspaceId: string,
): Promise<WorkspaceRecord | null> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const [row] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspaceId)))
      .limit(1)
    return row ?? null
  })
}

type DesiredWorkspaceRecord = Pick<
  WorkspaceRecord,
  | "id"
  | "desiredGeneration"
  | "workspaceRepositoryUrl"
  | "githubConnectionId"
  | "desiredSha"
  | "desiredDefaultBranch"
>

function desiredWorkspaceRevision(
  row: DesiredWorkspaceRecord,
): WorkspaceRevision | null {
  if (!row.desiredSha || !row.desiredDefaultBranch) return null
  return workspaceRevisionSchema.parse({
    workspaceId: row.id,
    generation: row.desiredGeneration,
    remote: {
      url: row.workspaceRepositoryUrl,
      githubConnectionId: row.githubConnectionId,
    },
    defaultBranch: row.desiredDefaultBranch,
    sha: row.desiredSha,
    access: "read",
  })
}

function projectionFromWorkspace(row: WorkspaceRecord): ProjectionState {
  const desired = desiredWorkspaceRevision(row)
  const index = row.hydratePhases?.index
  const active = row.activeRevision
    ? workspaceRevisionSchema.parse(row.activeRevision)
    : null
  const previous: PublishedProjection | null = active
    ? {
        kind: "active",
        revision: active,
        stores: {
          embeddings: sameWorkspaceRevision(row.hydratePhases?.revision, active)
            ? row.hydratePhases?.embeddings
              ? { kind: "ready" }
              : row.hydratePhases?.embeddingError
                ? { kind: "failed", message: row.hydratePhases.embeddingError }
                : { kind: "pending" }
            : { kind: "pending" },
          graph: { kind: "postgres" },
          index:
            index && sameWorkspaceRevision(index.revision, active)
              ? index.result
              : { kind: "pending" },
        },
      }
    : row.activeProjectionSha
      ? {
          kind: "legacy",
          url: row.activeProjectionUrl,
          sha: row.activeProjectionSha,
        }
      : null
  if (row.hydrateStatus === "failed")
    return {
      kind: "failed",
      desired,
      previous,
      error: row.hydrateError ?? "Hydration failed",
    }
  if (
    desired &&
    previous?.kind === "active" &&
    sameWorkspaceRevision(previous.revision, desired)
  )
    return previous
  if (!desired && !previous && !row.desiredSha) return { kind: "absent" }
  return { kind: "building", desired, previous }
}

export async function getWorkspaceProjection(
  workspaceId: string,
): Promise<ProjectionState> {
  const row = await getWorkspaceById(workspaceId)
  return row ? projectionFromWorkspace(row) : { kind: "absent" }
}

export async function getDesiredWorkspaceRevision(
  workspaceId: string,
): Promise<WorkspaceRevision | null> {
  const row = await getWorkspaceById(workspaceId)
  return row ? desiredWorkspaceRevision(row) : null
}

/** Failed discovery has no invented SHA; fence the exact database target that was observed. */
export async function persistRevisionResolutionFailure(input: {
  expected: DesiredWorkspaceRecord
  message: string
}): Promise<void> {
  await orgSql(async () => {
    const expected = input.expected
    const revision = desiredWorkspaceRevision(expected)
    await getOrgDb()
      .update(workspaces)
      .set({
        hydrateStatus: "failed",
        hydrateError: input.message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, expected.id),
          eq(workspaces.desiredGeneration, expected.desiredGeneration),
          eq(
            workspaces.workspaceRepositoryUrl,
            expected.workspaceRepositoryUrl,
          ),
          sql`${workspaces.githubConnectionId} is not distinct from ${expected.githubConnectionId}`,
          sql`${workspaces.desiredSha} is not distinct from ${expected.desiredSha}`,
          sql`${workspaces.desiredDefaultBranch} is not distinct from ${expected.desiredDefaultBranch ?? null}`,
          revision
            ? sql`${workspaces.activeRevision} is distinct from ${JSON.stringify(revision)}::jsonb`
            : undefined,
        ),
      )
  })
}

/** One database snapshot binds search membership and indexed commits to the published projection. */
export async function getWorkspaceSearchProjection(workspaceId: string) {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        workspace: workspaces,
        linked: sql<
          Array<{ gitUrl: string; indexedSha: string | null }>
        >`coalesce((
        select jsonb_agg(jsonb_build_object('gitUrl', ${workspaceLinkedRepositories.gitUrl}, 'indexedSha', ${workspaceLinkedRepositories.indexedSha}))
        from ${workspaceLinkedRepositories}
        where ${workspaceLinkedRepositories.workspaceId} = ${workspaces.id}
      ), '[]'::jsonb)`,
        repository: {
          id: repositories.id,
          name: repositories.name,
          gitUrl: repositories.gitUrl,
        },
        checkout: {
          zoektRepoId: repositoryCheckouts.zoektRepoId,
          sha: repositoryCheckouts.commitSha,
        },
      })
      .from(workspaces)
      .leftJoin(repositories, eq(repositories.orgId, workspaces.orgId))
      .leftJoin(
        repositoryCheckouts,
        and(
          eq(repositoryCheckouts.repositoryId, repositories.id),
          eq(repositoryCheckouts.checkoutKey, sql`'ws:' || ${workspaces.id}`),
        ),
      )
      .where(eq(workspaces.id, workspaceId))
    const first = rows[0]
    const projection: ProjectionState = first
      ? projectionFromWorkspace(first.workspace)
      : { kind: "absent" }
    const active = publishedProjection(projection)
    const allowed = new Map<string, string>()
    if (active?.kind === "active" && active.stores.index.kind === "ready") {
      allowed.set(
        normalizeWorkspaceRepositoryUrl(active.revision.remote.url),
        active.revision.sha,
      )
    } else if (active?.kind === "legacy" && active.url) {
      allowed.set(normalizeWorkspaceRepositoryUrl(active.url), active.sha)
    }
    if (active)
      for (const linked of first?.linked ?? []) {
        if (linked.indexedSha)
          allowed.set(
            normalizeWorkspaceRepositoryUrl(linked.gitUrl),
            linked.indexedSha,
          )
      }
    return {
      projection,
      repositories: rows.flatMap(({ repository, checkout }) => {
        if (!repository || !checkout) return []
        const sha = allowed.get(
          normalizeWorkspaceRepositoryUrl(repository.gitUrl),
        )
        if (!sha || checkout.sha !== sha) return []
        return [{ ...repository, zoektRepoId: checkout.zoektRepoId, sha }]
      }),
    }
  })
}

export type WorkspaceProjectionSnapshot = {
  projection: ProjectionState
  units: Array<
    HydrateUnit & { projectionSha: string; embedding: number[] | null }
  >
}

/** Metadata and units are observed in one SQL statement, including during activation. */
export async function getWorkspaceProjectionSnapshot(
  workspaceId: string,
): Promise<WorkspaceProjectionSnapshot> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        workspace: workspaces,
        unit: {
          servingId: workspaceKnowledgeUnits.servingId,
          path: workspaceKnowledgeUnits.path,
          body: workspaceKnowledgeUnits.body,
          links: workspaceKnowledgeUnits.links,
          claims: workspaceKnowledgeUnits.claims,
          projectionSha: workspaceKnowledgeUnits.projectionSha,
          embedding: workspaceKnowledgeUnits.embedding,
        },
      })
      .from(workspaces)
      .leftJoin(
        workspaceKnowledgeUnits,
        and(
          eq(workspaceKnowledgeUnits.workspaceId, workspaces.id),
          eq(
            workspaceKnowledgeUnits.projectionSha,
            sql`coalesce(${workspaces.activeRevision}->>'sha', ${workspaces.activeProjectionSha})`,
          ),
        ),
      )
      .where(eq(workspaces.id, workspaceId))
      .orderBy(workspaceKnowledgeUnits.path)
    const first = rows[0]
    return {
      projection: first
        ? projectionFromWorkspace(first.workspace)
        : { kind: "absent" },
      units: rows.flatMap(({ unit }) => (unit ? [unit] : [])),
    }
  })
}

/** Bind branch metadata to the same desired database identity observed before Git I/O. */
export async function captureWorkspaceRevision(input: {
  workspaceId: string
  expected: {
    generation: number
    url: string
    sha: string | null
    defaultBranch: string | null
    githubConnectionId: string | null
  }
  tip: { sha: string; branch: string }
}): Promise<WorkspaceRevision | null> {
  workspaceRevisionSchema.parse({
    workspaceId: input.workspaceId,
    generation: input.expected.generation,
    remote: {
      url: input.expected.url,
      githubConnectionId: input.expected.githubConnectionId,
    },
    sha: input.tip.sha,
    defaultBranch: input.tip.branch,
    access: "read",
  })
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaces)
      .set({
        desiredDefaultBranch: input.tip.branch,
        desiredSha: input.tip.sha,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, input.workspaceId),
          eq(workspaces.desiredGeneration, input.expected.generation),
          eq(workspaces.workspaceRepositoryUrl, input.expected.url),
          sql`${workspaces.desiredSha} is not distinct from ${input.expected.sha}`,
          sql`${workspaces.desiredDefaultBranch} is not distinct from ${input.expected.defaultBranch}`,
          input.expected.githubConnectionId === null
            ? sql`${workspaces.githubConnectionId} is null`
            : eq(
                workspaces.githubConnectionId,
                input.expected.githubConnectionId,
              ),
        ),
      )
      .returning()
    return row ? desiredWorkspaceRevision(row) : null
  })
}

export async function createWorkspace(input: {
  gitUrl: string
  displayName?: string
  slug?: string
  githubConnectionId?: string
  write?: WorkspaceWriteProbe
}): Promise<WorkspaceRecord & { autoLinkGitUrls: string[] }> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()
    const workspaceRepositoryUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
    if (!workspaceRepositoryUrl) {
      throw createError({
        message: "A git URL is required",
        status: 400,
        why: "Workspace create needs a workspace repository URL",
      })
    }

    const desiredSlug = input.slug?.trim()
      ? normalizeSlug(input.slug)
      : slugFromGitUrl(input.gitUrl)
    const displayName =
      input.displayName?.trim() || displayNameFromGitUrl(input.gitUrl)

    const urlConflict = () =>
      createError({
        message:
          "That git URL is already the workspace repository of another Workspace in this organisation",
        status: 409,
        why: "A URL may back at most one Workspace per org",
      })

    const maxAttempts = 8
    let lastError: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const existingUrl = await tx
            .select()
            .from(workspaces)
            .where(
              and(
                eq(workspaces.orgId, orgId),
                eq(workspaces.workspaceRepositoryUrl, workspaceRepositoryUrl),
              ),
            )
            .limit(1)
          if (existingUrl[0]) {
            let row = existingUrl[0]
            if (input.write) {
              const [updated] = await tx
                .update(workspaces)
                .set({
                  writeStatus: input.write.writeStatus,
                  readOnlyReason: input.write.readOnlyReason,
                  ...(input.githubConnectionId !== undefined
                    ? { githubConnectionId: input.githubConnectionId }
                    : {}),
                  updatedAt: new Date(),
                })
                .where(eq(workspaces.id, row.id))
                .returning()
              if (updated) row = updated
            }
            return { ...row, autoLinkGitUrls: [] }
          }

          const slugRows = await tx
            .select({ slug: workspaces.slug })
            .from(workspaces)
            .where(eq(workspaces.orgId, orgId))
          const slug = nextSlugCandidate(
            desiredSlug,
            new Set(slugRows.map((row) => row.slug.toLowerCase())),
          )

          const [row] = await tx
            .insert(workspaces)
            .values({
              id: generateObjectId("ws"),
              orgId,
              slug,
              displayName,
              workspaceRepositoryUrl,
              githubConnectionId: input.githubConnectionId ?? null,
              desiredGeneration: 1,
              hydrateStatus: "pending",
              ...(input.write ??
                writeStatusFromClassification({
                  workspaceRepositoryUrl,
                  githubConnectionId: input.githubConnectionId ?? null,
                })),
            })
            .returning()

          if (!row) throw new Error("Failed to create workspace")

          const autoLinkGitUrls: string[] = []
          const siblings = await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.orgId, orgId))
          if (siblings.length === 1) {
            const orgRepos = await tx
              .select({ gitUrl: repositories.gitUrl })
              .from(repositories)
              .where(eq(repositories.orgId, orgId))
            for (const repo of orgRepos) {
              const gitUrl = normalizeWorkspaceRepositoryUrl(repo.gitUrl)
              if (!gitUrl || gitUrl === workspaceRepositoryUrl) continue
              autoLinkGitUrls.push(gitUrl)
            }
          }

          await tx
            .insert(orgMemberPreferences)
            .values({
              userId,
              orgId,
              lastUsedWorkspaceId: row.id,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [orgMemberPreferences.userId, orgMemberPreferences.orgId],
              set: {
                lastUsedWorkspaceId: row.id,
                updatedAt: new Date(),
              },
            })

          return { ...row, autoLinkGitUrls }
        })
      } catch (error) {
        if (isUniqueViolation(error, "workspaces_org_id_repository_url_uidx")) {
          const raced = await db
            .select()
            .from(workspaces)
            .where(
              and(
                eq(workspaces.orgId, orgId),
                eq(workspaces.workspaceRepositoryUrl, workspaceRepositoryUrl),
              ),
            )
            .limit(1)
          if (raced[0]) {
            let row = raced[0]
            if (input.write) {
              const [updated] = await db
                .update(workspaces)
                .set({
                  writeStatus: input.write.writeStatus,
                  readOnlyReason: input.write.readOnlyReason,
                  ...(input.githubConnectionId !== undefined
                    ? { githubConnectionId: input.githubConnectionId }
                    : {}),
                  updatedAt: new Date(),
                })
                .where(eq(workspaces.id, row.id))
                .returning()
              if (updated) row = updated
            }
            return { ...row, autoLinkGitUrls: [] }
          }
          throw urlConflict()
        }
        if (
          isUniqueViolation(error, "workspaces_org_id_slug") &&
          attempt < maxAttempts - 1
        ) {
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to create workspace")
  })
}

export async function updateWorkspace(
  slug: string,
  input: {
    displayName?: string
    slug?: string
    workspaceRepositoryUrl?: string
    githubConnectionId?: string | null
    readOnlyReason?: string | null
    write?: WorkspaceWriteProbe
  },
): Promise<WorkspaceRecord | null> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const existing = await getWorkspaceBySlug(slug)
    if (!existing) return null

    const patch: Partial<typeof workspaces.$inferInsert> = {
      updatedAt: new Date(),
    }

    if (input.displayName !== undefined) {
      const name = input.displayName.trim()
      if (!name) {
        throw createError({
          message: "Display name cannot be empty",
          status: 400,
          why: "Workspace display name must be non-empty",
        })
      }
      patch.displayName = name
    }

    if (input.slug !== undefined) {
      const next = normalizeSlug(input.slug)
      if (!isValidSlug(next)) {
        throw createError({
          message: "Slug must be lowercase letters, numbers, and hyphens",
          status: 400,
          why: "Invalid workspace slug",
        })
      }
      if (next !== existing.slug) {
        const taken = await takenSlugs(orgId, existing.id)
        if (taken.has(next)) {
          throw createError({
            message: "That slug is already used by another Workspace",
            status: 409,
            why: "Workspace slugs are unique per organisation",
          })
        }
        patch.slug = next
      }
    }

    if (input.workspaceRepositoryUrl !== undefined) {
      const nextUrl = normalizeWorkspaceRepositoryUrl(
        input.workspaceRepositoryUrl,
      )
      if (!nextUrl) {
        throw createError({
          message: "A git URL is required",
          status: 400,
          why: "Relink needs a workspace repository URL",
        })
      }
      if (nextUrl !== existing.workspaceRepositoryUrl) {
        const [conflict] = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.orgId, orgId),
              eq(workspaces.workspaceRepositoryUrl, nextUrl),
            ),
          )
          .limit(1)
        if (conflict && conflict.id !== existing.id) {
          throw createError({
            message:
              "That git URL is already the workspace repository of another Workspace in this organisation",
            status: 409,
            why: "A URL may back at most one Workspace per org",
          })
        }
        patch.workspaceRepositoryUrl = nextUrl
        const connectionId =
          input.githubConnectionId !== undefined
            ? input.githubConnectionId
            : existing.githubConnectionId
        Object.assign(
          patch,
          nextRelinkFields(
            existing.desiredGeneration,
            input.write ??
              writeStatusFromClassification({
                workspaceRepositoryUrl: nextUrl,
                githubConnectionId: connectionId,
              }),
          ),
        )
      } else if (input.write) {
        patch.writeStatus = input.write.writeStatus
        patch.readOnlyReason = input.write.readOnlyReason
      }
    } else if (input.write) {
      patch.writeStatus = input.write.writeStatus
      patch.readOnlyReason = input.write.readOnlyReason
    }

    if (input.githubConnectionId !== undefined) {
      patch.githubConnectionId = input.githubConnectionId
    }
    if (input.readOnlyReason !== undefined) {
      patch.readOnlyReason = input.readOnlyReason
    }

    try {
      const [updated] = await db
        .update(workspaces)
        .set(patch)
        .where(and(eq(workspaces.id, existing.id), eq(workspaces.orgId, orgId)))
        .returning()
      return updated ?? null
    } catch (error) {
      if (isUniqueViolation(error, "workspaces_org_id_slug")) {
        throw createError({
          message: "That slug is already used by another Workspace",
          status: 409,
          why: "Workspace slugs are unique per organisation",
        })
      }
      if (isUniqueViolation(error, "workspaces_org_id_repository_url_uidx")) {
        throw createError({
          message:
            "That git URL is already the workspace repository of another Workspace in this organisation",
          status: 409,
          why: "A URL may back at most one Workspace per org",
        })
      }
      throw error
    }
  })
}

export async function deleteWorkspace(
  slug: string,
  confirmName: string,
): Promise<{ id: string } | false> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const normalised = slug.trim().toLowerCase()
    if (!isValidSlug(normalised)) return false

    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workspaces)
        .where(
          and(eq(workspaces.orgId, orgId), eq(workspaces.slug, normalised)),
        )
        .limit(1)
      if (!row) return false
      if (confirmName !== row.displayName) {
        throw createError({
          message: "Type the Workspace display name to confirm delete",
          status: 400,
          why: "confirmName must match the Workspace display name",
        })
      }

      await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.orgId, orgId),
            eq(conversations.workspaceId, row.id),
          ),
        )
      await tx
        .delete(workspaces)
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, row.id)))
      return { id: row.id }
    })
  })
}

export async function listOrgWorkspaces(
  orgId: string,
): Promise<
  Array<
    Pick<
      WorkspaceRecord,
      | "id"
      | "workspaceRepositoryUrl"
      | "desiredGeneration"
      | "desiredSha"
      | "desiredDefaultBranch"
      | "activeProjectionSha"
      | "githubConnectionId"
      | "writeStatus"
      | "createdAt"
      | "lastJobAt"
    >
  >
> {
  return orgSql(() =>
    getOrgDb()
      .select({
        id: workspaces.id,
        workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
        desiredGeneration: workspaces.desiredGeneration,
        desiredSha: workspaces.desiredSha,
        desiredDefaultBranch: workspaces.desiredDefaultBranch,
        activeProjectionSha: workspaces.activeProjectionSha,
        githubConnectionId: workspaces.githubConnectionId,
        writeStatus: workspaces.writeStatus,
        createdAt: workspaces.createdAt,
        lastJobAt: workspaces.lastJobAt,
      })
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId)),
  )
}

export async function listOrgLinkedRepositories(orgId: string): Promise<
  Array<{
    id: string
    workspaceId: string
    gitUrl: string
    desiredRef: string | null
    desiredSha: string | null
    indexedSha: string | null
  }>
> {
  return orgSql(() =>
    getOrgDb()
      .select({
        id: workspaceLinkedRepositories.id,
        workspaceId: workspaceLinkedRepositories.workspaceId,
        gitUrl: workspaceLinkedRepositories.gitUrl,
        desiredRef: workspaceLinkedRepositories.desiredRef,
        desiredSha: workspaceLinkedRepositories.desiredSha,
        indexedSha: workspaceLinkedRepositories.indexedSha,
      })
      .from(workspaceLinkedRepositories)
      .innerJoin(
        workspaces,
        eq(workspaceLinkedRepositories.workspaceId, workspaces.id),
      )
      .where(eq(workspaces.orgId, orgId)),
  )
}

export async function persistResolvedDesiredSha(input: {
  workspaceId: string
  resolvedTip: string
  expectedGeneration: number
  expectedUrl: string
  expectedDesiredSha?: string | null
}): Promise<boolean> {
  const sha = applyResolvedDesiredSha(input.resolvedTip)
  if (!sha) return false
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        desiredSha: sha,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, input.workspaceId),
          eq(workspaces.desiredGeneration, input.expectedGeneration),
          eq(workspaces.workspaceRepositoryUrl, input.expectedUrl),
          input.expectedDesiredSha === undefined
            ? undefined
            : input.expectedDesiredSha
              ? eq(workspaces.desiredSha, input.expectedDesiredSha)
              : sql`${workspaces.desiredSha} is null`,
        ),
      )
      .returning({ id: workspaces.id })
    return updated != null
  })
}

export async function persistIndexedSha(input: {
  workspaceId: string
  indexedSha: string
  expectedGeneration: number
  expectedUrl: string
  expectedDesiredSha: string
}): Promise<boolean> {
  return orgSql(async () => {
    const existing = await getWorkspaceById(input.workspaceId)
    if (!existing) return false
    const decision = shouldPublishIndex({
      jobGeneration: input.expectedGeneration,
      desiredGeneration: existing.desiredGeneration,
      jobWorkspaceUrl: input.expectedUrl,
      desiredWorkspaceUrl: existing.workspaceRepositoryUrl,
      jobDesiredSha: input.expectedDesiredSha,
      currentDesiredSha: existing.desiredSha,
      remoteStillMember: true,
    })
    if (!decision.publish) return false
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        indexedSha: input.indexedSha,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, input.workspaceId),
          eq(workspaces.desiredGeneration, input.expectedGeneration),
          eq(workspaces.workspaceRepositoryUrl, input.expectedUrl),
          eq(workspaces.desiredSha, input.expectedDesiredSha),
        ),
      )
      .returning({ id: workspaces.id })
    return updated != null
  })
}

export async function touchLastUsedWorkspace(
  workspaceId: string,
): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()
    const existing = await getWorkspaceById(workspaceId)
    if (!existing) {
      throw createError({
        message: "Workspace not found",
        status: 404,
        why: "Cannot record last-used for an unknown Workspace",
      })
    }
    await db
      .insert(orgMemberPreferences)
      .values({
        userId,
        orgId,
        lastUsedWorkspaceId: workspaceId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [orgMemberPreferences.userId, orgMemberPreferences.orgId],
        set: {
          lastUsedWorkspaceId: workspaceId,
          updatedAt: new Date(),
        },
      })
  })
}

export async function listLinkedRepositories(
  workspaceId: string,
): Promise<WorkspaceLinkedRepositoryRecord[]> {
  return orgSql(async () => {
    const db = getOrgDb()
    const workspace = await getWorkspaceById(workspaceId)
    if (!workspace) {
      throw createError({
        message: "Workspace not found",
        status: 404,
        why: "Cannot list linked remotes for an unknown Workspace",
      })
    }
    return db
      .select()
      .from(workspaceLinkedRepositories)
      .where(eq(workspaceLinkedRepositories.workspaceId, workspaceId))
      .orderBy(workspaceLinkedRepositories.createdAt)
  })
}

export async function listWorkspaceKnowledgeFiles(
  workspaceId: string,
): Promise<Array<{ path: string; body: string }>> {
  return orgSql(() =>
    getOrgDb()
      .select({
        path: workspaceKnowledgeUnits.path,
        body: workspaceKnowledgeUnits.body,
      })
      .from(workspaceKnowledgeUnits)
      .where(eq(workspaceKnowledgeUnits.workspaceId, workspaceId))
      .orderBy(workspaceKnowledgeUnits.path),
  )
}

export async function listWorkspaceKnowledgeUnits(
  workspaceId: string,
): Promise<{
  units: HydrateUnit[]
  lastUpdatedAt: string | null
}> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        servingId: workspaceKnowledgeUnits.servingId,
        path: workspaceKnowledgeUnits.path,
        body: workspaceKnowledgeUnits.body,
        links: workspaceKnowledgeUnits.links,
        claims: workspaceKnowledgeUnits.claims,
        updatedAt: workspaceKnowledgeUnits.updatedAt,
      })
      .from(workspaceKnowledgeUnits)
      .where(eq(workspaceKnowledgeUnits.workspaceId, workspaceId))
      .orderBy(workspaceKnowledgeUnits.path)
    const lastUpdatedAt = rows.reduce<Date | null>((latest, row) => {
      if (!latest || row.updatedAt > latest) return row.updatedAt
      return latest
    }, null)
    return {
      units: rows.map((row) => ({
        servingId: row.servingId,
        path: row.path,
        body: row.body,
        links: row.links,
        claims: row.claims,
      })),
      lastUpdatedAt: lastUpdatedAt?.toISOString() ?? null,
    }
  })
}

export async function listKnowledgeUnitPaths(
  workspaceId: string,
): Promise<string[]> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({ path: workspaceKnowledgeUnits.path })
      .from(workspaceKnowledgeUnits)
      .where(eq(workspaceKnowledgeUnits.workspaceId, workspaceId))
    return rows.map((row) => row.path)
  })
}

export async function commitHydrateProjection(input: {
  orgId: string
  revision: WorkspaceRevision
  displayName: string | null
  remotes: ReadonlyArray<{ git: string; branch: string | null }>
  units: readonly HydrateUnit[]
}): Promise<boolean> {
  return orgSql(async () => {
    const db = getOrgDb()
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(workspaces)
        .set({
          activeRevision: input.revision,
          activeProjectionUrl: input.revision.remote.url,
          activeProjectionSha: input.revision.sha,
          hydrateStatus: "ready",
          hydrateError: null,
          hydratePhases: initialHydratePhases({
            url: input.revision.remote.url,
            sha: input.revision.sha,
            revision: input.revision,
          }),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workspaces.id, input.revision.workspaceId),
            eq(workspaces.desiredGeneration, input.revision.generation),
            eq(workspaces.workspaceRepositoryUrl, input.revision.remote.url),
            eq(workspaces.desiredSha, input.revision.sha),
            eq(workspaces.desiredDefaultBranch, input.revision.defaultBranch),
            input.revision.remote.githubConnectionId === null
              ? sql`${workspaces.githubConnectionId} is null`
              : eq(
                  workspaces.githubConnectionId,
                  input.revision.remote.githubConnectionId,
                ),
          ),
        )
        .returning({ id: workspaces.id })
      if (!updated) return false

      await tx
        .delete(workspaceKnowledgeUnits)
        .where(
          eq(workspaceKnowledgeUnits.workspaceId, input.revision.workspaceId),
        )
      if (input.units.length > 0) {
        const now = new Date()
        await tx.insert(workspaceKnowledgeUnits).values(
          input.units.map((unit) => ({
            servingId: unit.servingId,
            orgId: input.orgId,
            workspaceId: input.revision.workspaceId,
            path: unit.path,
            body: unit.body,
            projectionSha: input.revision.sha,
            links: unit.links,
            claims: unit.claims,
            createdAt: now,
            updatedAt: now,
          })),
        )
      }

      const workspaceUrl = normalizeWorkspaceRepositoryUrl(
        input.revision.remote.url,
      )
      const desired = new Map<string, string | null>()
      for (const remote of input.remotes) {
        const gitUrl = normalizeWorkspaceRepositoryUrl(remote.git)
        if (!gitUrl || gitUrl === workspaceUrl || desired.has(gitUrl)) continue
        desired.set(gitUrl, remote.branch)
      }
      const existingLinked = await tx
        .select()
        .from(workspaceLinkedRepositories)
        .where(
          eq(
            workspaceLinkedRepositories.workspaceId,
            input.revision.workspaceId,
          ),
        )
      const existingByUrl = new Map(
        existingLinked.map((row) => [row.gitUrl, row]),
      )
      for (const row of existingLinked) {
        if (!desired.has(row.gitUrl)) {
          await tx
            .delete(workspaceLinkedRepositories)
            .where(eq(workspaceLinkedRepositories.id, row.id))
        }
      }
      for (const [gitUrl, branch] of desired) {
        const current = existingByUrl.get(gitUrl)
        if (!current) {
          await tx.insert(workspaceLinkedRepositories).values({
            id: generateObjectId("wlr"),
            orgId: input.orgId,
            workspaceId: input.revision.workspaceId,
            gitUrl,
            desiredRef: branch,
          })
          continue
        }
        if (current.desiredRef === branch) continue
        await tx
          .update(workspaceLinkedRepositories)
          .set({
            desiredRef: branch,
            desiredSha: null,
          })
          .where(eq(workspaceLinkedRepositories.id, current.id))
      }
      return true
    })
  })
}

export async function persistLinkedDesiredSha(input: {
  linkedId: string
  resolvedTip: string
  expectedDesiredSha: string | null
}): Promise<boolean> {
  return orgSql(async () => {
    const sha = applyResolvedDesiredSha(input.resolvedTip)
    if (!sha) return false
    const [updated] = await getOrgDb()
      .update(workspaceLinkedRepositories)
      .set({ desiredSha: sha })
      .where(
        and(
          eq(workspaceLinkedRepositories.id, input.linkedId),
          input.expectedDesiredSha
            ? eq(
                workspaceLinkedRepositories.desiredSha,
                input.expectedDesiredSha,
              )
            : sql`${workspaceLinkedRepositories.desiredSha} is null`,
        ),
      )
      .returning({ id: workspaceLinkedRepositories.id })
    return updated != null
  })
}

export async function persistLinkedIndexedSha(input: {
  linkedId: string
  revision: WorkspaceRevision
  indexedSha: string
  expectedDesiredSha: string
  expectedLinkedUrl: string
  expectedLinkedRef: string | null
}): Promise<boolean> {
  return orgSql(async () => {
    const db = getOrgDb()
    const [updated] = await db
      .update(workspaceLinkedRepositories)
      .set({ indexedSha: input.indexedSha })
      .where(
        and(
          eq(workspaceLinkedRepositories.id, input.linkedId),
          eq(
            workspaceLinkedRepositories.workspaceId,
            input.revision.workspaceId,
          ),
          eq(workspaceLinkedRepositories.desiredSha, input.expectedDesiredSha),
          eq(workspaceLinkedRepositories.gitUrl, input.expectedLinkedUrl),
          input.expectedLinkedRef
            ? eq(
                workspaceLinkedRepositories.desiredRef,
                input.expectedLinkedRef,
              )
            : sql`${workspaceLinkedRepositories.desiredRef} is null`,
          exists(
            db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                and(
                  eq(workspaces.id, input.revision.workspaceId),
                  sql`${workspaces.activeRevision} = ${JSON.stringify(input.revision)}::jsonb`,
                ),
              ),
          ),
        ),
      )
      .returning({ id: workspaceLinkedRepositories.id })
    return updated != null
  })
}

export async function getOrgFirstWorkspace(orgId: string): Promise<{
  workspaceId: string
  sourceRepositoryId: string
} | null> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select({
        workspaceId: orgFirstWorkspaces.workspaceId,
        sourceRepositoryId: orgFirstWorkspaces.sourceRepositoryId,
      })
      .from(orgFirstWorkspaces)
      .where(eq(orgFirstWorkspaces.orgId, orgId))
      .limit(1)
    return row ?? null
  })
}

export async function persistOrgFirstWorkspace(input: {
  orgId: string
  workspaceId: string
  sourceRepositoryId: string
}): Promise<void> {
  return orgSql(async () => {
    await getOrgDb()
      .insert(orgFirstWorkspaces)
      .values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        sourceRepositoryId: input.sourceRepositoryId,
      })
      .onConflictDoNothing({ target: orgFirstWorkspaces.orgId })
  })
}

export async function listOrgRepositoriesForDestAssignment(): Promise<
  Array<{ id: string; gitUrl: string; createdAt: Date }>
> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    return getOrgDb()
      .select({
        id: repositories.id,
        gitUrl: repositories.gitUrl,
        createdAt: repositories.createdAt,
      })
      .from(repositories)
      .where(eq(repositories.orgId, orgId))
  })
}

export async function applyDestWorkspaceLinkPlan(
  plan: DestWorkspaceLinkPlan,
): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    if (plan.deleteLinkIds.length > 0) {
      await db
        .delete(workspaceLinkedRepositories)
        .where(
          and(
            eq(workspaceLinkedRepositories.orgId, orgId),
            inArray(workspaceLinkedRepositories.id, plan.deleteLinkIds),
          ),
        )
    }
    for (const link of plan.insertLinks) {
      await db
        .insert(workspaceLinkedRepositories)
        .values({
          id: generateObjectId("wlr"),
          orgId,
          workspaceId: link.workspaceId,
          gitUrl: link.gitUrl,
        })
        .onConflictDoNothing({
          target: [
            workspaceLinkedRepositories.workspaceId,
            workspaceLinkedRepositories.gitUrl,
          ],
        })
    }
  })
}

export async function reconcileDestWorkspaceAssignment(orgId: string): Promise<{
  firstWorkspaceId: string | null
  firstSourceRepositoryId: string | null
}> {
  return orgSql(async () => {
    const [workspaceRows, repositoryRows, existingLinks, persistedFirst] =
      await Promise.all([
        getOrgDb()
          .select({
            id: workspaces.id,
            workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
          })
          .from(workspaces)
          .where(eq(workspaces.orgId, orgId)),
        getOrgDb()
          .select({
            id: repositories.id,
            gitUrl: repositories.gitUrl,
            createdAt: repositories.createdAt,
          })
          .from(repositories)
          .where(eq(repositories.orgId, orgId)),
        getOrgDb()
          .select({
            id: workspaceLinkedRepositories.id,
            workspaceId: workspaceLinkedRepositories.workspaceId,
            gitUrl: workspaceLinkedRepositories.gitUrl,
          })
          .from(workspaceLinkedRepositories)
          .where(eq(workspaceLinkedRepositories.orgId, orgId)),
        getOrgDb()
          .select({
            workspaceId: orgFirstWorkspaces.workspaceId,
            sourceRepositoryId: orgFirstWorkspaces.sourceRepositoryId,
          })
          .from(orgFirstWorkspaces)
          .where(eq(orgFirstWorkspaces.orgId, orgId))
          .limit(1),
      ])
    const connectorTargetRepositoryIds = repositoryRows
      .filter((repo) =>
        workspaceRows.some((row) => row.workspaceRepositoryUrl === repo.gitUrl),
      )
      .map((repo) => repo.id)
    const plan = planDestWorkspaceLinks({
      workspaces: workspaceRows,
      repositories: repositoryRows,
      connectorTargetRepositoryIds,
      existingLinks,
    })
    if (plan.firstWorkspaceId && plan.firstSourceRepositoryId) {
      await persistOrgFirstWorkspace({
        orgId,
        workspaceId: plan.firstWorkspaceId,
        sourceRepositoryId: plan.firstSourceRepositoryId,
      })
    }
    await applyDestWorkspaceLinkPlan(plan)
    const first = persistedFirst[0]
    return {
      firstWorkspaceId: first?.workspaceId ?? plan.firstWorkspaceId,
      firstSourceRepositoryId:
        first?.sourceRepositoryId ?? plan.firstSourceRepositoryId,
    }
  })
}

export async function persistHydrateFailure(input: {
  revision: WorkspaceRevision
  message: string
}): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaces)
      .set({
        hydrateStatus: "failed",
        hydrateError: input.message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, input.revision.workspaceId),
          eq(workspaces.desiredGeneration, input.revision.generation),
          eq(workspaces.workspaceRepositoryUrl, input.revision.remote.url),
          eq(workspaces.desiredSha, input.revision.sha),
          eq(workspaces.desiredDefaultBranch, input.revision.defaultBranch),
          sql`${workspaces.activeRevision} is distinct from ${JSON.stringify(input.revision)}::jsonb`,
          input.revision.remote.githubConnectionId === null
            ? sql`${workspaces.githubConnectionId} is null`
            : eq(
                workspaces.githubConnectionId,
                input.revision.remote.githubConnectionId,
              ),
        ),
      )
  })
}

export async function persistHydrateRetry(
  workspaceId: string,
): Promise<WorkspaceRecord | undefined> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        hydrateStatus: "pending",
        hydrateError: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId))
      .returning()
    return updated
  })
}

export async function persistWriteStatus(
  workspaceId: string,
  write: WorkspaceWriteProbe,
  orgId: string,
): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaces)
      .set({
        writeStatus: write.writeStatus,
        readOnlyReason: write.readOnlyReason,
        updatedAt: new Date(),
      })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, orgId)))
  })
}

/** Record derived index freshness without changing the published PostgreSQL content. */
export async function persistWorkspaceIndexResult(input: {
  revision: WorkspaceRevision
  result: DerivedStoreResult
}): Promise<boolean> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        indexedSha: input.result.kind === "ready" ? input.revision.sha : null,
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || ${JSON.stringify({ index: input })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, input.revision.workspaceId),
          sql`${workspaces.activeRevision} = ${JSON.stringify(input.revision)}::jsonb`,
        ),
      )
      .returning({ id: workspaces.id })
    return updated != null
  })
}

/** Record an embedding error only for the projection that requested those vectors. */
export async function persistEmbeddingFailure(input: {
  revision: WorkspaceRevision
  message: string
}): Promise<void> {
  await orgSql(() =>
    getOrgDb()
      .update(workspaces)
      .set({
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || ${JSON.stringify(
          {
            ...initialHydratePhases({
              url: input.revision.remote.url,
              sha: input.revision.sha,
              revision: input.revision,
            }),
            embeddingError: input.message,
          },
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, input.revision.workspaceId),
          sql`${workspaces.activeRevision} = ${JSON.stringify(input.revision)}::jsonb`,
        ),
      )
      .then(() => undefined),
  )
}

/** Store vectors and their completion marker under the active revision's row lock. */
export async function persistUnitEmbeddings(input: {
  revision: WorkspaceRevision
  embeddings: ReadonlyArray<{ servingId: string; embedding: number[] }>
}): Promise<boolean> {
  return orgSql(() =>
    getOrgDb().transaction(async (tx) => {
      const [workspace] = await tx
        .select({ activeRevision: workspaces.activeRevision })
        .from(workspaces)
        .where(eq(workspaces.id, input.revision.workspaceId))
        .for("update")
      if (!sameWorkspaceRevision(workspace?.activeRevision, input.revision))
        return false
      if (input.embeddings.length > 0) {
        const values = input.embeddings.map(
          (row) =>
            sql`(${row.servingId}, ${JSON.stringify(row.embedding)}::jsonb)`,
        )
        await tx.execute(sql`
        UPDATE workspace_knowledge_units AS u
        SET embedding = v.embedding, updated_at = NOW()
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(serving_id, embedding)
        WHERE u.serving_id = v.serving_id
          AND u.workspace_id = ${input.revision.workspaceId}
          AND u.projection_sha = ${input.revision.sha}
      `)
      }
      await tx
        .update(workspaces)
        .set({
          hydratePhases: sql`(coalesce(${workspaces.hydratePhases}, '{}'::jsonb) - 'embeddingError') || ${JSON.stringify(
            {
              ...initialHydratePhases({
                url: input.revision.remote.url,
                sha: input.revision.sha,
                revision: input.revision,
              }),
              embeddings: true,
            },
          )}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, input.revision.workspaceId))
      return true
    }),
  )
}

export * from "./workspace-sandboxes.js"
export * from "./workspace-write-jobs.js"
