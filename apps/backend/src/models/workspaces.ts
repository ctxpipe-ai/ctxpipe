import {
  and,
  asc,
  desc,
  eq,
  exists,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm"
import { createError } from "evlog"
import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { repositories } from "../db/schema/repositories.js"
import {
  orgMemberPreferences,
  orgWorkspaceCutover,
  workspaceKnowledgeUnits,
  workspaceLinkedRepositories,
  workspaceSandboxInstances,
  workspaces,
  workspaceWriteJobs,
} from "../db/schema/workspaces.js"
import type { HydrateUnit } from "../domain/workspaces/hydrate.js"
import {
  type HydratePhaseRecord,
  initialHydratePhases,
} from "../domain/workspaces/hydrate-phases.js"
import { firstConnectorTarget } from "../domain/workspaces/migration-cutover.js"
import { nextRelinkFields } from "../domain/workspaces/relink.js"
import {
  applyResolvedDesiredSha,
  indexPublishTargets,
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
import type { WorkspaceWriteKind } from "../domain/workspaces/write-commit-files.js"
import {
  type WorkspaceWriteJobPayload,
  WRITE_JOB_STATUSES,
} from "../domain/workspaces/write-job-intent.js"
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
}): Promise<WorkspaceRecord & { autoLinkGitUrls: string[] }> {
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

        const cutover = await tx
          .select({ firstWorkspaceId: orgWorkspaceCutover.firstWorkspaceId })
          .from(orgWorkspaceCutover)
          .where(eq(orgWorkspaceCutover.orgId, orgId))
          .limit(1)
        if (!cutover[0]) {
          const created = await tx
            .select({
              id: workspaces.id,
              createdAt: workspaces.createdAt,
            })
            .from(workspaces)
            .where(eq(workspaces.orgId, orgId))
          const first = firstConnectorTarget(created)
          if (first) {
            await tx.insert(orgWorkspaceCutover).values({
              orgId,
              firstWorkspaceId: first.id,
            })
          }
        }

        return { ...row, autoLinkGitUrls }
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

/** Version-start create: no member prefs and no first-Workspace auto-link. */
export async function createCutoverWorkspace(input: {
  gitUrl: string
  displayName?: string
  githubConnectionId?: string | null
}): Promise<WorkspaceRecord> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const workspaceRepositoryUrl = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  if (!workspaceRepositoryUrl) {
    throw createError({
      message: "A git URL is required",
      status: 400,
      why: "Cutover create needs a workspace repository URL",
    })
  }
  const existing = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.orgId, orgId),
        eq(workspaces.workspaceRepositoryUrl, workspaceRepositoryUrl),
      ),
    )
    .limit(1)
  if (existing[0]) return existing[0]

  const desiredSlug = slugFromGitUrl(input.gitUrl)
  const displayName =
    input.displayName?.trim() || displayNameFromGitUrl(input.gitUrl)
  const slugRows = await db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.orgId, orgId))
  const slug = nextSlugCandidate(
    desiredSlug,
    new Set(slugRows.map((row) => row.slug.toLowerCase())),
  )
  try {
    const [row] = await db
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
        ...writeStatusFromClassification({
          workspaceRepositoryUrl,
          githubConnectionId: input.githubConnectionId ?? null,
        }),
      })
      .returning()
    if (row) return row
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
      if (raced[0]) return raced[0]
    }
    throw error
  }
  throw new Error("Failed to create cutover workspace")
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

export async function deleteWorkspace(
  slug: string,
  confirmName: string,
): Promise<{ id: string } | false> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const normalised = slug.trim().toLowerCase()
  if (!isValidSlug(normalised)) return false

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.slug, normalised)))
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
      .delete(orgWorkspaceCutover)
      .where(
        and(
          eq(orgWorkspaceCutover.orgId, orgId),
          eq(orgWorkspaceCutover.firstWorkspaceId, row.id),
        ),
      )
    await tx
      .delete(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, row.id)))
    return { id: row.id }
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
      | "activeProjectionSha"
      | "githubConnectionId"
      | "createdAt"
      | "lastJobAt"
    >
  >
> {
  return getOrgDb()
    .select({
      id: workspaces.id,
      workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
      desiredGeneration: workspaces.desiredGeneration,
      desiredSha: workspaces.desiredSha,
      activeProjectionSha: workspaces.activeProjectionSha,
      githubConnectionId: workspaces.githubConnectionId,
      createdAt: workspaces.createdAt,
      lastJobAt: workspaces.lastJobAt,
    })
    .from(workspaces)
    .where(eq(workspaces.orgId, orgId))
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
  return getOrgDb()
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
    .where(eq(workspaces.orgId, orgId))
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
    jobWorkspaceId: input.workspaceId,
    desiredWorkspaceId: existing.id,
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
      hydrateError: null,
      hydratePhases: initialHydratePhases({
        url: existing.workspaceRepositoryUrl,
        sha: input.hydratedSha,
      }),
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

export async function listWorkspaceKnowledgeFiles(
  workspaceId: string,
): Promise<Array<{ path: string; body: string }>> {
  return getOrgDb()
    .select({
      path: workspaceKnowledgeUnits.path,
      body: workspaceKnowledgeUnits.body,
    })
    .from(workspaceKnowledgeUnits)
    .where(eq(workspaceKnowledgeUnits.workspaceId, workspaceId))
    .orderBy(workspaceKnowledgeUnits.path)
}

export async function listWorkspaceKnowledgeUnits(
  workspaceId: string,
): Promise<{
  units: HydrateUnit[]
  lastUpdatedAt: string | null
}> {
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
}

export async function listKnowledgeUnitPaths(
  workspaceId: string,
): Promise<string[]> {
  const rows = await getOrgDb()
    .select({ path: workspaceKnowledgeUnits.path })
    .from(workspaceKnowledgeUnits)
    .where(eq(workspaceKnowledgeUnits.workspaceId, workspaceId))
  return rows.map((row) => row.path)
}

export async function commitHydrateProjection(input: {
  orgId: string
  workspaceId: string
  jobGeneration: number
  jobWorkspaceUrl: string
  hydratedSha: string
  displayName: string | null
  remotes: ReadonlyArray<{ git: string; branch: string | null }>
  units: readonly HydrateUnit[]
}): Promise<boolean> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1)
    if (!existing) return false
    const decision = shouldActivateHydrateProjection({
      jobGeneration: input.jobGeneration,
      desiredGeneration: existing.desiredGeneration,
      jobWorkspaceUrl: input.jobWorkspaceUrl,
      desiredWorkspaceUrl: existing.workspaceRepositoryUrl,
      jobWorkspaceId: input.workspaceId,
      desiredWorkspaceId: existing.id,
      hydratedSha: input.hydratedSha,
      desiredSha: existing.desiredSha,
    })
    if (!decision.activate) return false

    const [updated] = await tx
      .update(workspaces)
      .set({
        activeProjectionUrl: existing.workspaceRepositoryUrl,
        activeProjectionSha: input.hydratedSha,
        hydrateStatus: "ready",
        hydrateError: null,
        hydratePhases: initialHydratePhases({
          url: existing.workspaceRepositoryUrl,
          sha: input.hydratedSha,
        }),
        ...(input.displayName ? { displayName: input.displayName } : {}),
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
    if (!updated) return false

    await tx
      .delete(workspaceKnowledgeUnits)
      .where(eq(workspaceKnowledgeUnits.workspaceId, input.workspaceId))
    if (input.units.length > 0) {
      const now = new Date()
      await tx.insert(workspaceKnowledgeUnits).values(
        input.units.map((unit) => ({
          servingId: unit.servingId,
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          path: unit.path,
          body: unit.body,
          projectionSha: input.hydratedSha,
          links: unit.links,
          claims: unit.claims,
          createdAt: now,
          updatedAt: now,
        })),
      )
    }

    const workspaceUrl = normalizeWorkspaceRepositoryUrl(input.jobWorkspaceUrl)
    const desired = new Map<string, string | null>()
    for (const remote of input.remotes) {
      const gitUrl = normalizeWorkspaceRepositoryUrl(remote.git)
      if (!gitUrl || gitUrl === workspaceUrl || desired.has(gitUrl)) continue
      desired.set(gitUrl, remote.branch)
    }
    const existingLinked = await tx
      .select()
      .from(workspaceLinkedRepositories)
      .where(eq(workspaceLinkedRepositories.workspaceId, input.workspaceId))
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
    return true
  })
}

export async function persistLinkedDesiredSha(input: {
  linkedId: string
  resolvedTip: string
  expectedDesiredSha: string | null
}): Promise<boolean> {
  const sha = applyResolvedDesiredSha(input.resolvedTip)
  if (!sha) return false
  const [updated] = await getOrgDb()
    .update(workspaceLinkedRepositories)
    .set({ desiredSha: sha })
    .where(
      and(
        eq(workspaceLinkedRepositories.id, input.linkedId),
        input.expectedDesiredSha
          ? eq(workspaceLinkedRepositories.desiredSha, input.expectedDesiredSha)
          : sql`${workspaceLinkedRepositories.desiredSha} is null`,
      ),
    )
    .returning({ id: workspaceLinkedRepositories.id })
  return updated != null
}

export async function persistLinkedIndexedSha(input: {
  linkedId: string
  workspaceId: string
  indexedSha: string
  expectedDesiredSha: string
  expectedGeneration: number
  expectedWorkspaceUrl: string
  expectedLinkedUrl: string
  expectedLinkedRef: string | null
}): Promise<boolean> {
  const db = getOrgDb()
  const [updated] = await db
    .update(workspaceLinkedRepositories)
    .set({ indexedSha: input.indexedSha })
    .where(
      and(
        eq(workspaceLinkedRepositories.id, input.linkedId),
        eq(workspaceLinkedRepositories.workspaceId, input.workspaceId),
        eq(workspaceLinkedRepositories.desiredSha, input.expectedDesiredSha),
        eq(workspaceLinkedRepositories.gitUrl, input.expectedLinkedUrl),
        input.expectedLinkedRef
          ? eq(workspaceLinkedRepositories.desiredRef, input.expectedLinkedRef)
          : sql`${workspaceLinkedRepositories.desiredRef} is null`,
        exists(
          db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.id, input.workspaceId),
                eq(workspaces.desiredGeneration, input.expectedGeneration),
                eq(
                  workspaces.workspaceRepositoryUrl,
                  input.expectedWorkspaceUrl,
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ id: workspaceLinkedRepositories.id })
  return updated != null
}

export async function persistLastJobAt(workspaceId: string): Promise<void> {
  await getOrgDb()
    .update(workspaces)
    .set({ lastJobAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId))
}

export async function getWriteJobCommitSha(
  jobId: string,
): Promise<string | null> {
  const [row] = await getOrgDb()
    .select({ commitSha: workspaceWriteJobs.commitSha })
    .from(workspaceWriteJobs)
    .where(eq(workspaceWriteJobs.id, jobId))
    .limit(1)
  return row?.commitSha ?? null
}

export async function persistWriteJobIntent(input: {
  id: string
  workspaceId: string
  kind: string
  generation: number
  desiredSha?: string | null
  status: string
  payload: WorkspaceWriteJobPayload
}): Promise<void> {
  const now = new Date()
  await getOrgDb()
    .insert(workspaceWriteJobs)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      generation: input.generation,
      desiredSha: input.desiredSha ?? null,
      status: input.status,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceWriteJobs.id,
      set: {
        kind: input.kind,
        generation: input.generation,
        desiredSha: input.desiredSha ?? null,
        status: input.status,
        payload: input.payload,
        updatedAt: now,
      },
      setWhere: sql`${workspaceWriteJobs.commitSha} is null`,
    })
}

export async function persistWriteJobStart(input: {
  id: string
  workspaceId: string
  kind: string
  generation: number
  desiredSha?: string | null
  payload?: WorkspaceWriteJobPayload
}): Promise<void> {
  const now = new Date()
  await getOrgDb()
    .insert(workspaceWriteJobs)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      generation: input.generation,
      desiredSha: input.desiredSha ?? null,
      status: WRITE_JOB_STATUSES.running,
      payload: input.payload ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceWriteJobs.id,
      set: {
        status: WRITE_JOB_STATUSES.running,
        ...(input.payload ? { payload: input.payload } : {}),
        desiredSha: input.desiredSha ?? null,
        updatedAt: now,
      },
      setWhere: sql`${workspaceWriteJobs.commitSha} is null`,
    })
}

export async function persistWriteJobStatus(
  jobId: string,
  status: string,
): Promise<void> {
  await getOrgDb()
    .update(workspaceWriteJobs)
    .set({ status, updatedAt: new Date() })
    .where(eq(workspaceWriteJobs.id, jobId))
}

export async function listPausedWriteJobs(workspaceId: string): Promise<
  Array<{
    id: string
    kind: WorkspaceWriteKind
    generation: number
    desiredSha: string | null
    status: string
    payload: WorkspaceWriteJobPayload | null
  }>
> {
  const rows = await getOrgDb()
    .select({
      id: workspaceWriteJobs.id,
      kind: workspaceWriteJobs.kind,
      generation: workspaceWriteJobs.generation,
      desiredSha: workspaceWriteJobs.desiredSha,
      status: workspaceWriteJobs.status,
      payload: workspaceWriteJobs.payload,
    })
    .from(workspaceWriteJobs)
    .where(
      and(
        eq(workspaceWriteJobs.workspaceId, workspaceId),
        eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.paused),
      ),
    )
  return rows.map((row) => ({
    ...row,
    kind: row.kind as WorkspaceWriteKind,
  }))
}

export async function claimPausedWriteJob(jobId: string): Promise<boolean> {
  const [row] = await getOrgDb()
    .update(workspaceWriteJobs)
    .set({ status: WRITE_JOB_STATUSES.queued, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceWriteJobs.id, jobId),
        eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.paused),
      ),
    )
    .returning({ id: workspaceWriteJobs.id })
  return row != null
}

export async function countWriteJobAttempts(input: {
  workspaceId: string
  kind: string
  desiredSha: string
}): Promise<number> {
  const rows = await getOrgDb()
    .select({ id: workspaceWriteJobs.id })
    .from(workspaceWriteJobs)
    .where(
      and(
        eq(workspaceWriteJobs.workspaceId, input.workspaceId),
        eq(workspaceWriteJobs.kind, input.kind),
        eq(workspaceWriteJobs.desiredSha, input.desiredSha),
        notInArray(workspaceWriteJobs.status, [
          WRITE_JOB_STATUSES.paused,
          WRITE_JOB_STATUSES.queued,
        ]),
      ),
    )
  return rows.length
}

export async function persistWriteJobCommitSha(
  jobId: string,
  commitSha: string,
): Promise<void> {
  await getOrgDb()
    .update(workspaceWriteJobs)
    .set({
      commitSha,
      status: WRITE_JOB_STATUSES.completed,
      updatedAt: new Date(),
    })
    .where(eq(workspaceWriteJobs.id, jobId))
}

export async function listCompletedMigrationExportWorkspaceIds(): Promise<
  string[]
> {
  const rows = await getOrgDb()
    .select({ workspaceId: workspaceWriteJobs.workspaceId })
    .from(workspaceWriteJobs)
    .where(
      and(
        eq(workspaceWriteJobs.kind, "migration_export"),
        isNotNull(workspaceWriteJobs.commitSha),
      ),
    )
  return [...new Set(rows.map((row) => row.workspaceId))]
}

export async function listMigrationExportShas(): Promise<Map<string, string>> {
  const rows = await getOrgDb()
    .select({
      workspaceId: workspaceWriteJobs.workspaceId,
      commitSha: workspaceWriteJobs.commitSha,
    })
    .from(workspaceWriteJobs)
    .where(
      and(
        eq(workspaceWriteJobs.kind, "migration_export"),
        isNotNull(workspaceWriteJobs.commitSha),
      ),
    )
    .orderBy(asc(workspaceWriteJobs.createdAt))
  const shas = new Map<string, string>()
  for (const row of rows) {
    if (row.commitSha && !shas.has(row.workspaceId)) {
      shas.set(row.workspaceId, row.commitSha)
    }
  }
  return shas
}

export async function getMigrationExportSha(
  workspaceId: string,
): Promise<string | null> {
  const [row] = await getOrgDb()
    .select({ commitSha: workspaceWriteJobs.commitSha })
    .from(workspaceWriteJobs)
    .where(
      and(
        eq(workspaceWriteJobs.workspaceId, workspaceId),
        eq(workspaceWriteJobs.kind, "migration_export"),
        isNotNull(workspaceWriteJobs.commitSha),
      ),
    )
    .orderBy(asc(workspaceWriteJobs.createdAt))
    .limit(1)
  return row?.commitSha ?? null
}

export async function persistHydrateFailure(input: {
  workspaceId: string
  message: string
}): Promise<void> {
  await getOrgDb()
    .update(workspaces)
    .set({
      hydrateStatus: "failed",
      hydrateError: input.message,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, input.workspaceId))
}

export async function persistHydrateRetry(
  workspaceId: string,
): Promise<WorkspaceRecord | undefined> {
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
}

export async function persistWriteStatus(
  workspaceId: string,
  write: WorkspaceWriteProbe,
): Promise<void> {
  await getOrgDb()
    .update(workspaces)
    .set({
      writeStatus: write.writeStatus,
      readOnlyReason: write.readOnlyReason,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
}

export async function persistUnitEmbeddings(input: {
  workspaceId: string
  projectionSha: string
  embeddings: ReadonlyArray<{ servingId: string; embedding: number[] }>
}): Promise<void> {
  if (input.embeddings.length === 0) return
  const values = input.embeddings.map(
    (row) => sql`(${row.servingId}, ${JSON.stringify(row.embedding)}::jsonb)`,
  )
  await getOrgDb().execute(sql`
    UPDATE workspace_knowledge_units AS u
    SET embedding = v.embedding, updated_at = NOW()
    FROM (VALUES ${sql.join(values, sql`, `)}) AS v(serving_id, embedding)
    WHERE u.serving_id = v.serving_id
      AND u.workspace_id = ${input.workspaceId}
      AND u.projection_sha = ${input.projectionSha}
  `)
}

export async function persistHydratePhases(input: {
  workspaceId: string
  expectedUrl: string
  expectedSha: string
  phases: HydratePhaseRecord
}): Promise<void> {
  await getOrgDb()
    .update(workspaces)
    .set({
      hydratePhases: input.phases,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        eq(workspaces.workspaceRepositoryUrl, input.expectedUrl),
        eq(workspaces.desiredSha, input.expectedSha),
        eq(workspaces.activeProjectionUrl, input.expectedUrl),
        eq(workspaces.activeProjectionSha, input.expectedSha),
      ),
    )
}

export async function getPersistedFirstWorkspaceId(
  orgId = requireCurrentOrgId(),
): Promise<string | null> {
  const [row] = await getOrgDb()
    .select({ firstWorkspaceId: orgWorkspaceCutover.firstWorkspaceId })
    .from(orgWorkspaceCutover)
    .where(eq(orgWorkspaceCutover.orgId, orgId))
    .limit(1)
  return row?.firstWorkspaceId ?? null
}

export async function persistFirstWorkspaceId(
  firstWorkspaceId: string,
  orgId = requireCurrentOrgId(),
): Promise<void> {
  await getOrgDb()
    .insert(orgWorkspaceCutover)
    .values({ orgId, firstWorkspaceId })
    .onConflictDoNothing()
}

export async function findWorkspacesAndLinkedByGitUrl(gitUrl: string): Promise<{
  workspaces: Array<{
    id: string
    workspaceRepositoryUrl: string
    desiredGeneration: number
    desiredSha: string | null
  }>
  linked: Array<{
    id: string
    workspaceId: string
    gitUrl: string
    desiredSha: string | null
    desiredRef: string | null
    desiredGeneration: number
    workspaceUrl: string
  }>
}> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const wanted = normalizeWorkspaceRepositoryUrl(gitUrl)
  const workspaceRows = await db
    .select({
      id: workspaces.id,
      workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
      desiredGeneration: workspaces.desiredGeneration,
      desiredSha: workspaces.desiredSha,
    })
    .from(workspaces)
    .where(eq(workspaces.orgId, orgId))
  const linkedRows = await db
    .select({
      id: workspaceLinkedRepositories.id,
      workspaceId: workspaceLinkedRepositories.workspaceId,
      gitUrl: workspaceLinkedRepositories.gitUrl,
      desiredSha: workspaceLinkedRepositories.desiredSha,
      desiredRef: workspaceLinkedRepositories.desiredRef,
      desiredGeneration: workspaces.desiredGeneration,
      workspaceUrl: workspaces.workspaceRepositoryUrl,
    })
    .from(workspaceLinkedRepositories)
    .innerJoin(
      workspaces,
      eq(workspaceLinkedRepositories.workspaceId, workspaces.id),
    )
    .where(eq(workspaces.orgId, orgId))
  return {
    workspaces: workspaceRows.filter(
      (row) =>
        normalizeWorkspaceRepositoryUrl(row.workspaceRepositoryUrl) === wanted,
    ),
    linked: linkedRows.filter(
      (row) => normalizeWorkspaceRepositoryUrl(row.gitUrl) === wanted,
    ),
  }
}

export async function publishWorkspaceIndexForGitUrl(input: {
  gitUrl: string
  indexedSha: string
  jobGeneration?: number
  jobWorkspaceUrl?: string
}): Promise<number> {
  const found = await findWorkspacesAndLinkedByGitUrl(input.gitUrl)
  const targets = indexPublishTargets({
    gitUrl: input.gitUrl,
    indexedSha: input.indexedSha,
    normalizeUrl: normalizeWorkspaceRepositoryUrl,
    jobGeneration: input.jobGeneration,
    jobWorkspaceUrl: input.jobWorkspaceUrl,
    workspaces: found.workspaces,
    linked: found.linked,
  })
  let published = 0
  for (const target of targets) {
    if (target.role === "linked" && target.linkedId) {
      if (
        await persistLinkedIndexedSha({
          linkedId: target.linkedId,
          workspaceId: target.workspaceId,
          indexedSha: input.indexedSha,
          expectedDesiredSha: target.expectedDesiredSha,
          expectedGeneration: target.expectedGeneration,
          expectedWorkspaceUrl: target.expectedUrl,
          expectedLinkedUrl: target.expectedLinkedUrl ?? target.expectedUrl,
          expectedLinkedRef: target.expectedLinkedRef ?? null,
        })
      ) {
        published += 1
      }
      continue
    }
    if (
      await persistIndexedSha({
        workspaceId: target.workspaceId,
        indexedSha: input.indexedSha,
        expectedGeneration: target.expectedGeneration,
        expectedUrl: target.expectedUrl,
        expectedDesiredSha: target.expectedDesiredSha,
      })
    ) {
      published += 1
    }
  }
  return published
}

export type SandboxInstanceRecord = {
  id: string
  kind: "chat" | "job"
  orgId?: string | null
  workspaceId: string
  conversationId?: string | null
  desiredUrl?: string | null
  desiredGeneration?: number | null
  desiredSha?: string | null
  state: "live" | "destroy_failed"
  lastHeartbeatAt: Date
}

export async function persistSandboxInstance(
  input: SandboxInstanceRecord,
): Promise<void> {
  const now = new Date()
  await getOrgDb()
    .insert(workspaceSandboxInstances)
    .values({
      id: input.id,
      kind: input.kind,
      orgId: input.orgId ?? null,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId ?? null,
      desiredUrl: input.desiredUrl ?? null,
      desiredGeneration: input.desiredGeneration ?? null,
      desiredSha: input.desiredSha ?? null,
      state: input.state,
      lastHeartbeatAt: input.lastHeartbeatAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceSandboxInstances.id,
      set: {
        kind: input.kind,
        conversationId: input.conversationId ?? null,
        desiredUrl: input.desiredUrl ?? null,
        desiredGeneration: input.desiredGeneration ?? null,
        desiredSha: input.desiredSha ?? null,
        state: input.state,
        lastHeartbeatAt: input.lastHeartbeatAt,
        updatedAt: now,
      },
    })
}

export async function listSandboxInstances(input: {
  workspaceId?: string
  conversationId?: string
  state?: "live" | "destroy_failed"
}): Promise<SandboxInstanceRecord[]> {
  const db = getOrgDb()
  const filters = [
    input.workspaceId
      ? eq(workspaceSandboxInstances.workspaceId, input.workspaceId)
      : undefined,
    input.conversationId
      ? eq(workspaceSandboxInstances.conversationId, input.conversationId)
      : undefined,
    input.state ? eq(workspaceSandboxInstances.state, input.state) : undefined,
  ].filter((value): value is NonNullable<typeof value> => value != null)
  const rows = await db
    .select()
    .from(workspaceSandboxInstances)
    .where(filters.length > 0 ? and(...filters) : undefined)
  return rows.flatMap((row) => {
    if (row.kind !== "chat" && row.kind !== "job") return []
    if (row.state !== "live" && row.state !== "destroy_failed") return []
    return [
      {
        id: row.id,
        kind: row.kind,
        orgId: row.orgId,
        workspaceId: row.workspaceId,
        conversationId: row.conversationId,
        desiredUrl: row.desiredUrl,
        desiredGeneration: row.desiredGeneration,
        desiredSha: row.desiredSha,
        state: row.state,
        lastHeartbeatAt: row.lastHeartbeatAt,
      },
    ]
  })
}

export async function deleteSandboxInstance(id: string): Promise<void> {
  await getOrgDb()
    .delete(workspaceSandboxInstances)
    .where(eq(workspaceSandboxInstances.id, id))
}
