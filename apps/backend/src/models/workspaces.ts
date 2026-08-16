import { and, desc, eq, isNotNull, sql } from "drizzle-orm"
import { createError } from "evlog"
import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { repositories } from "../db/schema/repositories.js"
import {
  orgMemberPreferences,
  workspaceKnowledgeUnits,
  workspaceLinkedRepositories,
  workspaces,
} from "../db/schema/workspaces.js"
import type { HydrateUnit } from "../domain/workspaces/hydrate.js"
import { nextRelinkFields } from "../domain/workspaces/relink.js"
import {
  applyResolvedDesiredSha,
  shouldActivateHydrateProjection,
  shouldPublishIndex,
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

export type WorkspaceRecord = typeof workspaces.$inferSelect
export type WorkspaceLinkedRepositoryRecord =
  typeof workspaceLinkedRepositories.$inferSelect

export type WorkspaceListItem = WorkspaceRecord & {
  mostRecentConversationId: string | null
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? String(error.code) : ""
  if (code !== "23505") return false
  const name =
    "constraint" in error && typeof error.constraint === "string"
      ? error.constraint
      : ""
  return name === constraint || name.includes(constraint)
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
}

export async function getWorkspaceBySlug(
  slug: string,
): Promise<WorkspaceRecord | null> {
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
}

export async function getWorkspaceById(
  workspaceId: string,
): Promise<WorkspaceRecord | null> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspaceId)))
    .limit(1)
  return row ?? null
}

export async function createWorkspace(input: {
  gitUrl: string
  displayName?: string
  slug?: string
  githubConnectionId?: string
  write?: WorkspaceWriteProbe
}): Promise<WorkspaceRecord> {
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
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.orgId, orgId),
              eq(workspaces.workspaceRepositoryUrl, workspaceRepositoryUrl),
            ),
          )
          .limit(1)
        if (existingUrl[0]) throw urlConflict()

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
            await tx
              .insert(workspaceLinkedRepositories)
              .values({
                id: generateObjectId("wlr"),
                workspaceId: row.id,
                gitUrl,
              })
              .onConflictDoNothing()
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

        return row
      })
    } catch (error) {
      if (isUniqueViolation(error, "workspaces_org_id_repository_url_uidx")) {
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
    }
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
      | "githubConnectionId"
    >
  >
> {
  return getOrgDb()
    .select({
      id: workspaces.id,
      workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
      desiredGeneration: workspaces.desiredGeneration,
      desiredSha: workspaces.desiredSha,
      githubConnectionId: workspaces.githubConnectionId,
    })
    .from(workspaces)
    .where(eq(workspaces.orgId, orgId))
}

export async function persistResolvedDesiredSha(input: {
  workspaceId: string
  resolvedTip: string
  expectedGeneration: number
  expectedUrl: string
}): Promise<boolean> {
  const sha = applyResolvedDesiredSha(input.resolvedTip)
  if (!sha) return false
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
      ),
    )
    .returning({ id: workspaces.id })
  return updated != null
}

export async function replaceWorkspaceKnowledgeProjection(input: {
  orgId: string
  workspaceId: string
  projectionSha: string
  units: readonly HydrateUnit[]
}): Promise<number> {
  const db = getOrgDb()
  await db
    .delete(workspaceKnowledgeUnits)
    .where(eq(workspaceKnowledgeUnits.workspaceId, input.workspaceId))
  if (input.units.length === 0) return 0
  const now = new Date()
  await db.insert(workspaceKnowledgeUnits).values(
    input.units.map((unit) => ({
      servingId: unit.servingId,
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      path: unit.path,
      body: unit.body,
      projectionSha: input.projectionSha,
      links: unit.links,
      claims: unit.claims,
      createdAt: now,
      updatedAt: now,
    })),
  )
  return input.units.length
}

export async function activateHydrateProjection(input: {
  workspaceId: string
  jobGeneration: number
  jobWorkspaceUrl: string
  hydratedSha: string
}): Promise<boolean> {
  const existing = await getWorkspaceById(input.workspaceId)
  if (!existing) return false
  const decision = shouldActivateHydrateProjection({
    jobGeneration: input.jobGeneration,
    desiredGeneration: existing.desiredGeneration,
    jobWorkspaceUrl: input.jobWorkspaceUrl,
    desiredWorkspaceUrl: existing.workspaceRepositoryUrl,
    hydratedSha: input.hydratedSha,
    desiredSha: existing.desiredSha,
  })
  if (!decision.activate) return false
  const [updated] = await getOrgDb()
    .update(workspaces)
    .set({
      activeProjectionUrl: existing.workspaceRepositoryUrl,
      activeProjectionSha: input.hydratedSha,
      hydrateStatus: "ready",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaces.id, existing.id),
        eq(workspaces.desiredGeneration, input.jobGeneration),
        eq(workspaces.workspaceRepositoryUrl, input.jobWorkspaceUrl),
        eq(workspaces.desiredSha, input.hydratedSha),
      ),
    )
    .returning({ id: workspaces.id })
  return updated != null
}

export async function persistIndexedSha(input: {
  workspaceId: string
  indexedSha: string
  expectedGeneration: number
  expectedUrl: string
  expectedDesiredSha: string
}): Promise<boolean> {
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
}

export async function touchLastUsedWorkspace(
  workspaceId: string,
): Promise<void> {
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
}

export async function listLinkedRepositories(
  workspaceId: string,
): Promise<WorkspaceLinkedRepositoryRecord[]> {
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
}

export async function linkRepository(input: {
  workspaceId: string
  gitUrl: string
}): Promise<WorkspaceLinkedRepositoryRecord> {
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace) {
    throw createError({
      message: "Workspace not found",
      status: 404,
      why: "Cannot link a remote to an unknown Workspace",
    })
  }
  const gitUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  if (!gitUrl) {
    throw createError({
      message: "A git URL is required",
      status: 400,
      why: "Link needs a git URL",
    })
  }
  if (gitUrl === workspace.workspaceRepositoryUrl) {
    throw createError({
      message: "The workspace repository is already included for search",
      status: 409,
      why: "Do not link the workspace repository to itself",
    })
  }

  try {
    const [row] = await getOrgDb()
      .insert(workspaceLinkedRepositories)
      .values({
        id: generateObjectId("wlr"),
        workspaceId: input.workspaceId,
        gitUrl,
      })
      .returning()
    if (!row) throw new Error("Failed to link repository")
    return row
  } catch (error) {
    if (
      isUniqueViolation(
        error,
        "workspace_linked_repositories_workspace_id_git_url_uidx",
      )
    ) {
      throw createError({
        message: "That git URL is already linked to this Workspace",
        status: 409,
        why: "Linked remotes are unique per Workspace",
      })
    }
    throw error
  }
}

export async function unlinkRepository(input: {
  workspaceId: string
  linkedId: string
}): Promise<boolean> {
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace) {
    throw createError({
      message: "Workspace not found",
      status: 404,
      why: "Cannot unlink a remote from an unknown Workspace",
    })
  }
  const [deleted] = await getOrgDb()
    .delete(workspaceLinkedRepositories)
    .where(
      and(
        eq(workspaceLinkedRepositories.id, input.linkedId),
        eq(workspaceLinkedRepositories.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: workspaceLinkedRepositories.id })
  return deleted != null
}

export async function updateWorkspaceDisplayName(
  workspaceId: string,
  displayName: string,
): Promise<boolean> {
  const name = displayName.trim()
  if (!name) return false
  const [updated] = await getOrgDb()
    .update(workspaces)
    .set({ displayName: name, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId))
    .returning({ id: workspaces.id })
  return updated != null
}

/** Replace the linked set from a hydrated SHA. First path already won; extras omitted. */
export async function syncLinkedRepositoriesFromHydrate(input: {
  workspaceId: string
  workspaceRepositoryUrl: string
  remotes: ReadonlyArray<{ git: string; branch: string | null }>
}): Promise<void> {
  const db = getOrgDb()
  const workspaceUrl = normalizeWorkspaceRepositoryUrl(
    input.workspaceRepositoryUrl,
  )
  const desired = new Map<string, string | null>()
  for (const remote of input.remotes) {
    const gitUrl = normalizeWorkspaceRepositoryUrl(remote.git)
    if (!gitUrl || gitUrl === workspaceUrl || desired.has(gitUrl)) continue
    desired.set(gitUrl, remote.branch)
  }

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(workspaceLinkedRepositories)
      .where(eq(workspaceLinkedRepositories.workspaceId, input.workspaceId))
    const existingByUrl = new Map(existing.map((row) => [row.gitUrl, row]))

    for (const row of existing) {
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
          workspaceId: input.workspaceId,
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
  })
}
