import { and, desc, eq, isNotNull, sql } from "drizzle-orm"
import { createError } from "evlog"
import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import {
  orgMemberPreferences,
  workspaceLinkedRepositories,
  workspaces,
} from "../db/schema/workspaces.js"
import {
  displayNameFromGitUrl,
  isValidSlug,
  nextSlugCandidate,
  normalizeSlug,
  normalizeWorkspaceRepositoryUrl,
  slugFromGitUrl,
} from "../domain/workspaces/slug.js"
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
          })
          .returning()

        if (!row) throw new Error("Failed to create workspace")

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
