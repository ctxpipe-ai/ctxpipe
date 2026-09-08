import {
  and,
  desc,
  eq,
  exists,
  getColumnTable,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { createError } from "evlog"
import { workspaceCheckoutPrefix } from "../../../../shared/workspace-checkout.js"
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
import { workspaceCheckoutKey } from "../domain/workspaces/derived-stores.js"
import {
  type DestWorkspaceLinkPlan,
  planDestWorkspaceLinks,
} from "../domain/workspaces/dest-workspace-assignment.js"
import type { HydrateUnit } from "../domain/workspaces/hydrate.js"
import { initialHydratePhases } from "../domain/workspaces/hydrate-phases.js"
import { nextRelinkFields } from "../domain/workspaces/relink.js"
import {
  type DerivedStoreResult,
  type LinkedReadBinding,
  type LinkedRevision,
  linkedRevisionSchema,
  type ProjectionState,
  type PublishedProjection,
  publishedProjection,
  sameWorkspaceRevision,
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
      connectionId: row.githubConnectionId,
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
          graph:
            row.hydratePhases?.graph &&
            sameWorkspaceRevision(row.hydratePhases.graph.revision, active)
              ? row.hydratePhases.graph.result
              : { kind: "pending" },
          index: {
            ...(index && sameWorkspaceRevision(index.revision, active)
              ? index.result
              : { kind: "pending" as const }),
            published:
              row.hydratePhases?.publishedIndex ??
              (index?.result.kind === "ready" ? index.revision : null),
          },
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
  access: WorkspaceRevision["access"] = "read",
): Promise<WorkspaceRevision | null> {
  const row = await getWorkspaceById(workspaceId)
  const revision = row ? desiredWorkspaceRevision(row) : null
  return revision ? { ...revision, access } : null
}

/** Revision and write access must come from the same PostgreSQL row version. */
export async function getWorkspaceWriteAdmission(workspaceId: string) {
  const row = await getWorkspaceById(workspaceId)
  const revision = row ? desiredWorkspaceRevision(row) : null
  return row && revision
    ? {
        revision: { ...revision, access: "write-default" as const },
        writeStatus: row.writeStatus,
        displayName: row.displayName,
      }
    : null
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
  const { projection, repositories } = await readWorkspaceProjectionSnapshot(
    workspaceId,
    false,
  )
  return { projection, repositories }
}

export type WorkspaceProjectionSnapshot = {
  projection: ProjectionState
  repositories: Array<{
    id: string
    name: string
    gitUrl: string
    zoektRepoId: number
    sha: string
    checkoutKey: string
  }>
  units: Array<
    HydrateUnit & { projectionSha: string; embedding: number[] | null }
  >
}

/** Metadata, units, vectors and repository membership share one SQL snapshot. */
export async function getWorkspaceProjectionSnapshot(
  workspaceId: string,
): Promise<WorkspaceProjectionSnapshot> {
  return readWorkspaceProjectionSnapshot(workspaceId, true)
}

// Preserve correlated-subquery qualifiers when Drizzle builds a single-table SELECT.
function qualified(column: AnyPgColumn) {
  return sql`${getColumnTable(column)}.${sql.identifier(column.name)}`
}

async function readWorkspaceProjectionSnapshot(
  workspaceId: string,
  includeUnits: boolean,
): Promise<WorkspaceProjectionSnapshot> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        workspace: workspaces,
        units: includeUnits
          ? sql<WorkspaceProjectionSnapshot["units"]>`coalesce((
          select jsonb_agg(jsonb_build_object(
            'servingId', ${qualified(workspaceKnowledgeUnits.servingId)},
            'path', ${qualified(workspaceKnowledgeUnits.path)},
            'body', ${qualified(workspaceKnowledgeUnits.body)},
            'links', ${qualified(workspaceKnowledgeUnits.links)},
            'claims', ${qualified(workspaceKnowledgeUnits.claims)},
            'projectionSha', ${qualified(workspaceKnowledgeUnits.projectionSha)},
            'embedding', ${qualified(workspaceKnowledgeUnits.embedding)}
          ) order by ${qualified(workspaceKnowledgeUnits.path)})
          from ${workspaceKnowledgeUnits}
          where ${qualified(workspaceKnowledgeUnits.workspaceId)} = ${qualified(workspaces.id)}
          and ${qualified(workspaceKnowledgeUnits.projectionSha)} = coalesce(${qualified(workspaces.activeRevision)}->>'sha', ${qualified(workspaces.activeProjectionSha)})
        ), '[]'::jsonb)`
          : sql<WorkspaceProjectionSnapshot["units"]>`'[]'::jsonb`,
        linked: sql<
          Array<{ gitUrl: string; indexedSha: string | null }>
        >`coalesce((
        select jsonb_agg(jsonb_build_object('gitUrl', ${qualified(workspaceLinkedRepositories.gitUrl)}, 'indexedSha', ${qualified(workspaceLinkedRepositories.indexedSha)}))
        from ${workspaceLinkedRepositories}
        where ${qualified(workspaceLinkedRepositories.workspaceId)} = ${qualified(workspaces.id)}
      ), '[]'::jsonb)`,
        indexedRepositories: sql<
          Array<{
            repository: { id: string; name: string; gitUrl: string }
            checkout: {
              zoektRepoId: number
              sha: string | null
              checkoutKey: string
            }
          }>
        >`coalesce((
          select jsonb_agg(jsonb_build_object(
            'repository', jsonb_build_object('id', ${qualified(repositories.id)}, 'name', ${qualified(repositories.name)}, 'gitUrl', ${qualified(repositories.gitUrl)}),
            'checkout', jsonb_build_object('zoektRepoId', ${qualified(repositoryCheckouts.zoektRepoId)}, 'sha', ${qualified(repositoryCheckouts.commitSha)}, 'checkoutKey', ${qualified(repositoryCheckouts.checkoutKey)})
          ))
          from ${repositories} join ${repositoryCheckouts} on ${qualified(repositoryCheckouts.repositoryId)} = ${qualified(repositories.id)}
          where ${qualified(repositories.orgId)} = ${qualified(workspaces.orgId)}
          and (${qualified(repositoryCheckouts.checkoutKey)} = ${workspaceCheckoutKey(workspaceId)} or ${qualified(repositoryCheckouts.checkoutKey)} = ${workspaceCheckoutPrefix(workspaceId)} || ${qualified(repositoryCheckouts.commitSha)})
        ), '[]'::jsonb)`,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
    const first = rows[0]
    const projection: ProjectionState = first
      ? projectionFromWorkspace(first.workspace)
      : { kind: "absent" }
    const active = publishedProjection(projection)
    const allowed = new Map<string, Set<string>>()
    const allow = (url: string, sha: string) => {
      const key = normalizeWorkspaceRepositoryUrl(url)
      const revisions = allowed.get(key) ?? new Set<string>()
      revisions.add(sha)
      allowed.set(key, revisions)
    }
    if (active?.kind === "active" && active.stores.index.published) {
      const indexed = active.stores.index.published
      allow(indexed.remote.url, indexed.sha)
    } else if (active?.kind === "legacy" && active.url) {
      allow(active.url, active.sha)
    }
    if (active)
      for (const linked of first?.linked ?? []) {
        if (linked.indexedSha) allow(linked.gitUrl, linked.indexedSha)
      }
    return {
      projection,
      units: first?.units ?? [],
      repositories: (first?.indexedRepositories ?? []).flatMap(
        ({ repository, checkout }) => {
          if (!repository || !checkout) return []
          const sha = checkout.sha
          if (
            !sha ||
            !allowed
              .get(normalizeWorkspaceRepositoryUrl(repository.gitUrl))
              ?.has(sha)
          )
            return []
          const checkoutKey = workspaceCheckoutKey(
            workspaceId,
            active?.kind === "active" ? sha : undefined,
          )
          if (checkout.checkoutKey !== checkoutKey) return []
          return [
            {
              ...repository,
              zoektRepoId: checkout.zoektRepoId,
              sha,
              checkoutKey,
            },
          ]
        },
      ),
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
      connectionId: input.expected.githubConnectionId,
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
            .for("update")
          if (existingUrl[0]) {
            let row = existingUrl[0]
            const connectionChanged =
              input.githubConnectionId !== undefined &&
              input.githubConnectionId !== row.githubConnectionId
            if (input.write || connectionChanged) {
              const write =
                input.write ??
                writeStatusFromClassification({
                  workspaceRepositoryUrl,
                  githubConnectionId:
                    input.githubConnectionId ?? row.githubConnectionId,
                })
              const [updated] = await tx
                .update(workspaces)
                .set({
                  ...write,
                  ...(connectionChanged
                    ? nextRelinkFields(row.desiredGeneration, write)
                    : {}),
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
          // Re-enter the same locked existing-URL path after an insert race.
          if (attempt < maxAttempts - 1) continue
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
      if (input.githubConnectionId !== existing.githubConnectionId) {
        Object.assign(
          patch,
          nextRelinkFields(
            existing.desiredGeneration,
            input.write ??
              writeStatusFromClassification({
                workspaceRepositoryUrl:
                  patch.workspaceRepositoryUrl ??
                  existing.workspaceRepositoryUrl,
                githubConnectionId: input.githubConnectionId,
              }),
          ),
        )
      }
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
          hydratePhases: sql`${JSON.stringify(
            initialHydratePhases({
              url: input.revision.remote.url,
              sha: input.revision.sha,
              revision: input.revision,
            }),
          )}::jsonb || jsonb_build_object('publishedIndex', coalesce(
            ${workspaces.hydratePhases}->'publishedIndex',
            case when ${workspaces.hydratePhases}->'index'->'result'->>'kind' = 'ready'
              then ${workspaces.hydratePhases}->'index'->'revision' end
          ))`,
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
            input.revision.remote.connectionId === null
              ? sql`${workspaces.githubConnectionId} is null`
              : eq(
                  workspaces.githubConnectionId,
                  input.revision.remote.connectionId,
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
            indexedSha: null,
          })
          .where(eq(workspaceLinkedRepositories.id, current.id))
      }
      return true
    })
  })
}

/** Invalidate linked tips in the same transaction as their repository connection changes. */
export async function invalidateLinkedReadBindings(
  gitUrls: readonly string[],
): Promise<void> {
  const urls = new Set(gitUrls.map(normalizeWorkspaceRepositoryUrl))
  if (urls.size === 0) return
  await orgSql(async () => {
    const db = getOrgDb()
    const linked = await db
      .select({
        id: workspaceLinkedRepositories.id,
        gitUrl: workspaceLinkedRepositories.gitUrl,
      })
      .from(workspaceLinkedRepositories)
    const ids = linked
      .filter((row) => urls.has(normalizeWorkspaceRepositoryUrl(row.gitUrl)))
      .map((row) => row.id)
    if (ids.length > 0)
      await db
        .update(workspaceLinkedRepositories)
        .set({ desiredSha: null, indexedSha: null })
        .where(inArray(workspaceLinkedRepositories.id, ids))
  })
}

/** Connection deletion is a relink, not an implicit foreign-key metadata edit. */
export async function detachWorkspaceConnection(
  connectionId: string,
): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaces)
      .set({
        ...nextRelinkFields(0),
        desiredGeneration: sql`${workspaces.desiredGeneration} + 1`,
        githubConnectionId: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.githubConnectionId, connectionId))
  })
}

/** Capture the owner, linked ref and connection in the same database statement. */
export async function getLinkedReadBinding(
  linkId: string,
): Promise<LinkedReadBinding | null> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        workspace: workspaces,
        linked: workspaceLinkedRepositories,
        repository: repositories,
      })
      .from(workspaceLinkedRepositories)
      .innerJoin(
        workspaces,
        eq(workspaces.id, workspaceLinkedRepositories.workspaceId),
      )
      .innerJoin(repositories, eq(repositories.orgId, workspaces.orgId))
      .where(eq(workspaceLinkedRepositories.id, linkId))
    const row = rows.find(
      (row) =>
        normalizeWorkspaceRepositoryUrl(row.repository.gitUrl) ===
        normalizeWorkspaceRepositoryUrl(row.linked.gitUrl),
    )
    if (!row) return null
    const owner = desiredWorkspaceRevision(row.workspace)
    if (!owner) return null
    return {
      owner,
      linkId: row.linked.id,
      repositoryId: row.repository.id,
      remote: {
        url: row.linked.gitUrl,
        connectionId: row.repository.githubConnectionId,
      },
      ref: row.linked.desiredRef,
      sha: row.linked.desiredSha,
    }
  })
}

function desiredRevisionPredicate(revision: WorkspaceRevision) {
  return and(
    eq(workspaces.id, revision.workspaceId),
    eq(workspaces.desiredGeneration, revision.generation),
    eq(workspaces.workspaceRepositoryUrl, revision.remote.url),
    eq(workspaces.desiredSha, revision.sha),
    eq(workspaces.desiredDefaultBranch, revision.defaultBranch),
    sql`${workspaces.githubConnectionId} is not distinct from ${revision.remote.connectionId}`,
  )
}

function linkedBindingPredicate(binding: LinkedReadBinding) {
  return and(
    eq(workspaceLinkedRepositories.id, binding.linkId),
    eq(workspaceLinkedRepositories.workspaceId, binding.owner.workspaceId),
    eq(workspaceLinkedRepositories.gitUrl, binding.remote.url),
    sql`${workspaceLinkedRepositories.desiredRef} is not distinct from ${binding.ref}`,
    sql`${workspaceLinkedRepositories.desiredSha} is not distinct from ${binding.sha}`,
    exists(
      getOrgDb()
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(desiredRevisionPredicate(binding.owner)),
    ),
    exists(
      getOrgDb()
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, binding.repositoryId),
            sql`${repositories.githubConnectionId} is not distinct from ${binding.remote.connectionId}`,
          ),
        ),
    ),
  )
}

export async function persistLinkedDesiredSha(input: {
  binding: LinkedReadBinding
  resolvedTip: string
}): Promise<boolean> {
  const revision = linkedRevisionSchema.parse({
    ...input.binding,
    sha: input.resolvedTip,
  })
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaceLinkedRepositories)
      .set({ desiredSha: revision.sha })
      .where(linkedBindingPredicate(input.binding))
      .returning({ id: workspaceLinkedRepositories.id })
    return updated != null
  })
}

export async function persistLinkedIndexedSha(
  revision: LinkedRevision,
): Promise<boolean> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaceLinkedRepositories)
      .set({ indexedSha: revision.sha })
      .where(
        and(
          linkedBindingPredicate(revision),
          exists(
            getOrgDb()
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                and(
                  eq(workspaces.id, revision.owner.workspaceId),
                  sql`${workspaces.activeRevision} = ${JSON.stringify(revision.owner)}::jsonb`,
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
          input.revision.remote.connectionId === null
            ? sql`${workspaces.githubConnectionId} is null`
            : eq(
                workspaces.githubConnectionId,
                input.revision.remote.connectionId,
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
        ...(input.result.kind === "ready"
          ? { indexedSha: input.revision.sha }
          : {}),
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || ${JSON.stringify(
          {
            index: input,
            ...(input.result.kind === "ready"
              ? { publishedIndex: input.revision }
              : {}),
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

/** Publish derived graph freshness only for the complete active revision. */
export async function persistWorkspaceGraphResult(input: {
  revision: WorkspaceRevision
  result: DerivedStoreResult
}): Promise<boolean> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || ${JSON.stringify({ graph: input })}::jsonb`,
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
