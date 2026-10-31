import {
  and,
  asc,
  desc,
  eq,
  getColumnTable,
  inArray,
  isNotNull,
  type SQL,
  sql,
} from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { createError } from "evlog"

import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  orgFirstWorkspaces,
  orgMemberPreferences,
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../db/schema/workspaces.js"
import { firstConnectorTarget } from "../domain/workspaces/dest-workspace-first.js"
import { initialHydratePhases } from "../domain/workspaces/hydrate-phases.js"
import {
  type HydrateSkip,
  type HydrateUnit,
  LEGACY_UNIT_SOURCE,
} from "../domain/workspaces/hydrate.js"
import {
  type KnowledgeChunkRow,
  knowledgeChunkRows,
} from "../domain/workspaces/knowledge-chunks.js"
import { nextRelinkFields } from "../domain/workspaces/relink.js"
import {
  type DerivedStoreResult,
  type LinkedReadBinding,
  type LinkedRevision,
  linkedRevisionSchema,
  type ProjectionState,
  type PublishedProjection,
  publishedProjection,
  sameWorkspaceBinding,
  sameWorkspaceRevision,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../domain/workspaces/revision.js"
import { workspaceRootPath } from "../domain/workspaces/root-path.js"
import {
  displayNameFromGitUrl,
  isValidSlug,
  nextSlugCandidate,
  normalizeSlug,
  normalizeWorkspaceRepositoryUrl,
  slugFromGitUrl,
} from "../domain/workspaces/slug.js"
import { withFormatWriteGate } from "../domain/workspaces/workspace-format.js"
import {
  WORKSPACE_WRITE_STATUSES,
  type WorkspaceWriteProbe,
  WRITE_STATUS_REASONS,
  writeStatusFromClassification,
} from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import { publishedRepositoryCheckoutKey } from "./repositories.js"
import {
  clearLinkedRepositoryShas,
  getLinkedRepositoryPin,
  type LinkedRepositoryPin,
  linkedSourcePins,
  listLinkedRepositoryPins,
  servedSourceStatesSql,
  updateLinkedRepositoryPin,
} from "./workspace-source-state.js"
import { isUniqueViolation, orgSql } from "./workspace-sql.js"

/** Transitional wire record; revision consumers use getWorkspaceProjection. */
export type WorkspaceRecord = Omit<
  typeof workspaces.$inferSelect,
  "activeRevision" | "desiredDefaultBranch"
> & {
  activeRevision?: WorkspaceRevision | null
  desiredDefaultBranch?: string | null
}
type WorkspaceLinkedRepositoryRecord = LinkedRepositoryPin

type WorkspaceListItem = WorkspaceRecord & {
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
        ...withFormatWriteGate(row),
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
    return row ? withFormatWriteGate(row) : null
  })
}

/** Pass `orgId` where no request or auth org context exists (workflows, sweeps). */
export async function getWorkspaceById(
  workspaceId: string,
  orgId?: string,
): Promise<WorkspaceRecord | null> {
  return orgSql(async () => {
    const id = orgId ?? requireCurrentOrgId()
    const db = getOrgDb()
    const [row] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, id), eq(workspaces.id, workspaceId)))
      .limit(1)
    return row ? withFormatWriteGate(row) : null
  })
}

export type WorkspaceWriteProbeBinding = Pick<
  WorkspaceRecord,
  | "id"
  | "desiredGeneration"
  | "workspaceRepositoryUrl"
  | "githubConnectionId"
  | "desiredSha"
  | "desiredDefaultBranch"
> & { rootPath?: string }

function desiredWorkspaceRevision(
  row: WorkspaceWriteProbeBinding,
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
    // Absent for the repository root, so that stored revisions stay equal in SQL.
    ...(workspaceRootPath(row) ? { rootPath: workspaceRootPath(row) } : {}),
  })
}

export function projectionFromWorkspace(row: WorkspaceRecord): ProjectionState {
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
  orgId?: string,
): Promise<WorkspaceRevision | null> {
  const row = await getWorkspaceById(workspaceId, orgId)
  const revision = row ? desiredWorkspaceRevision(row) : null
  return revision ? { ...revision, access } : null
}

/** Revision and write access must come from the same PostgreSQL row version. */
export async function getWorkspaceWriteAdmission(
  workspaceId: string,
  orgId?: string,
) {
  const row = await getWorkspaceById(workspaceId, orgId)
  const revision = row ? desiredWorkspaceRevision(row) : null
  return row && revision
    ? {
        revision: { ...revision, access: "write-default" as const },
        writeStatus: row.writeStatus,
        readOnlyReason: row.readOnlyReason,
        displayName: row.displayName,
      }
    : null
}

/** Failed discovery has no invented SHA; fence the exact database target that was observed. */
export async function persistRevisionResolutionFailure(input: {
  expected: WorkspaceWriteProbeBinding
  message: string
  /** Record it on a ready Workspace too: the next read fails the same way. */
  noAccess?: boolean
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
          revision && !input.noAccess
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
    HydrateUnit & {
      projectionSha: string
      /** The unit has chunks, and each chunk has an embedding. */
      embedded: boolean
    }
  >
  /** A unit of the active projection with text has no chunk rows (made before chunks existed). */
  chunksMissing: boolean
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
            'kind', ${qualified(workspaceKnowledgeUnits.kind)},
            'title', ${qualified(workspaceKnowledgeUnits.title)},
            'source', coalesce(${qualified(workspaceKnowledgeUnits.source)}, 'authored'),
            'updatedAt', ${qualified(workspaceKnowledgeUnits.updatedAt)},
            'body', ${qualified(workspaceKnowledgeUnits.body)},
            'links', ${qualified(workspaceKnowledgeUnits.links)},
            'claims', ${qualified(workspaceKnowledgeUnits.claims)},
            'projectionSha', ${qualified(workspaceKnowledgeUnits.projectionSha)},
            'embedded', exists (
              select 1 from ${workspaceKnowledgeChunks} as c
              where c.workspace_id = ${qualified(workspaceKnowledgeUnits.workspaceId)}
                and c.unit_id = ${qualified(workspaceKnowledgeUnits.servingId)}
            ) and not exists (
              select 1 from ${workspaceKnowledgeChunks} as c
              where c.workspace_id = ${qualified(workspaceKnowledgeUnits.workspaceId)}
                and c.unit_id = ${qualified(workspaceKnowledgeUnits.servingId)}
                and c.embedding is null
            )
          ) order by ${qualified(workspaceKnowledgeUnits.path)})
          from ${workspaceKnowledgeUnits}
          where ${qualified(workspaceKnowledgeUnits.workspaceId)} = ${qualified(workspaces.id)}
          and ${qualified(workspaceKnowledgeUnits.projectionSha)} = coalesce(${qualified(workspaces.activeRevision)}->>'sha', ${qualified(workspaces.activeProjectionSha)})
        ), '[]'::jsonb)`
          : sql<WorkspaceProjectionSnapshot["units"]>`'[]'::jsonb`,
        chunksMissing: sql<boolean>`exists (
          select 1 from ${workspaceKnowledgeUnits}
          where ${qualified(workspaceKnowledgeUnits.workspaceId)} = ${qualified(workspaces.id)}
          and ${qualified(workspaceKnowledgeUnits.projectionSha)} = coalesce(${qualified(workspaces.activeRevision)}->>'sha', ${qualified(workspaces.activeProjectionSha)})
          and ${unitWithoutChunks(qualified(workspaceKnowledgeUnits.workspaceId), qualified(workspaceKnowledgeUnits.servingId), qualified(workspaceKnowledgeUnits.body))}
        )`,
        linkedSources: servedSourceStatesSql(qualified(workspaces.id)),
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
            'checkout', jsonb_build_object('zoektRepoId', ${qualified(repositoryCheckouts.zoektRepoId)}, 'sha', coalesce(${qualified(repositoryCheckouts.commitSha)}, ${qualified(repositories.lastIngestedHash)}), 'checkoutKey', ${qualified(repositoryCheckouts.checkoutKey)})
          ))
          from ${repositories} join ${repositoryCheckouts} on ${qualified(repositoryCheckouts.repositoryId)} = ${qualified(repositories.id)}
          where ${qualified(repositories.orgId)} = ${qualified(workspaces.orgId)}
          and ${qualified(repositoryCheckouts.orgId)} = ${qualified(repositories.orgId)}
          and ${qualified(repositoryCheckouts.checkoutKey)} = ${publishedRepositoryCheckoutKey()}
        ), '[]'::jsonb)`,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
    const first = rows[0]
    const projection: ProjectionState = first
      ? projectionFromWorkspace(first.workspace)
      : { kind: "absent" }
    const active = publishedProjection(projection)
    // The repositories that the Workspace links: its own repository once
    // its index is published, and each linked source once it is indexed.
    const allowed = new Set<string>()
    const allow = (url: string) =>
      allowed.add(normalizeWorkspaceRepositoryUrl(url))
    if (active?.kind === "active" && active.stores.index.published) {
      allow(active.stores.index.published.remote.url)
    } else if (active?.kind === "legacy" && active.url) {
      allow(active.url)
    }
    if (active)
      for (const linked of linkedSourcePins(first?.linkedSources ?? [])) {
        if (linked.indexedSha) allow(linked.gitUrl)
      }
    return {
      projection,
      units: first?.units ?? [],
      chunksMissing: first?.chunksMissing ?? false,
      repositories: (first?.indexedRepositories ?? []).flatMap(
        ({ repository, checkout }) => {
          if (!repository || !checkout) return []
          // Workspace code reads use the published checkout of each
          // linked repository: the newest commit of its default branch.
          const sha = checkout.sha
          if (
            !sha ||
            !allowed.has(normalizeWorkspaceRepositoryUrl(repository.gitUrl))
          )
            return []
          const checkoutKey = checkout.checkoutKey
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
  /** Root folder in the repository; validated with `workspaceRootPathSchema`. */
  rootPath?: string
}): Promise<WorkspaceRecord> {
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
          "That git URL is already the workspace repository of another Workspace in this organization",
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
            return row
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
              rootPath: workspaceRootPath(input),
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
    rootPath?: string
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
            why: "Workspace slugs are unique per organization",
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
              "That git URL is already the workspace repository of another Workspace in this organization",
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
    if (input.rootPath !== undefined) {
      const rootPath = workspaceRootPath(input)
      // A new root folder is a new projection: start a new desired generation.
      if (rootPath !== workspaceRootPath(existing)) {
        patch.rootPath = rootPath
        if (patch.desiredGeneration === undefined)
          Object.assign(
            patch,
            nextRelinkFields(existing.desiredGeneration, input.write),
          )
      }
    }

    try {
      const [updated] = await db
        .update(workspaces)
        .set(patch)
        .where(and(eq(workspaces.id, existing.id), eq(workspaces.orgId, orgId)))
        .returning()
      return updated ? withFormatWriteGate(updated) : null
    } catch (error) {
      if (isUniqueViolation(error, "workspaces_org_id_slug")) {
        throw createError({
          message: "That slug is already used by another Workspace",
          status: 409,
          why: "Workspace slugs are unique per organization",
        })
      }
      if (isUniqueViolation(error, "workspaces_org_id_repository_url_uidx")) {
        throw createError({
          message:
            "That git URL is already the workspace repository of another Workspace in this organization",
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
        .delete(orgFirstWorkspaces)
        .where(
          and(
            eq(orgFirstWorkspaces.orgId, orgId),
            eq(orgFirstWorkspaces.workspaceId, row.id),
          ),
        )
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
      | "slug"
      | "displayName"
      | "workspaceRepositoryUrl"
      | "desiredGeneration"
      | "desiredSha"
      | "desiredDefaultBranch"
      | "activeProjectionSha"
      | "githubConnectionId"
      | "writeStatus"
      | "readOnlyReason"
      | "formatVersion"
      | "hydrateStatus"
      | "hydrateError"
      | "updatedAt"
      | "createdAt"
      | "lastJobAt"
      | "rootPath"
    >
  >
> {
  const rows = await orgSql(() =>
    getOrgDb()
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        displayName: workspaces.displayName,
        workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
        desiredGeneration: workspaces.desiredGeneration,
        desiredSha: workspaces.desiredSha,
        desiredDefaultBranch: workspaces.desiredDefaultBranch,
        activeProjectionSha: workspaces.activeProjectionSha,
        githubConnectionId: workspaces.githubConnectionId,
        writeStatus: workspaces.writeStatus,
        readOnlyReason: workspaces.readOnlyReason,
        formatVersion: workspaces.formatVersion,
        hydrateStatus: workspaces.hydrateStatus,
        hydrateError: workspaces.hydrateError,
        updatedAt: workspaces.updatedAt,
        createdAt: workspaces.createdAt,
        lastJobAt: workspaces.lastJobAt,
        rootPath: workspaces.rootPath,
      })
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId)),
  )
  return rows.map(withFormatWriteGate)
}

/** The projection state of every Workspace of the org, read in one query. */
export async function listOrgWorkspaceProjections(
  orgId: string,
): Promise<ProjectionState[]> {
  const rows = await orgSql(() =>
    getOrgDb().select().from(workspaces).where(eq(workspaces.orgId, orgId)),
  )
  return rows.map(projectionFromWorkspace)
}

/**
 * The index jobs that read `repositoryId`: the desired revision of each
 * Workspace whose own repository it is, and the read binding of each link to
 * it. Call it inside the org context.
 */
export async function listWorkspaceIndexTargets(input: {
  orgId: string
  repositoryId: string
}): Promise<{ owners: WorkspaceRevision[]; linked: LinkedRevision[] }> {
  const [repository] = await orgSql(() =>
    getOrgDb()
      .select({ gitUrl: repositories.gitUrl })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, input.orgId),
          eq(repositories.id, input.repositoryId),
        ),
      ),
  )
  const url = repository
    ? normalizeWorkspaceRepositoryUrl(repository.gitUrl)
    : null
  if (!url) return { owners: [], linked: [] }
  const owners = (
    await orgSql(() =>
      getOrgDb()
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, input.orgId),
            eq(workspaces.workspaceRepositoryUrl, url),
          ),
        ),
    )
  ).flatMap((row) => desiredWorkspaceRevision(row) ?? [])
  const linked: LinkedRevision[] = []
  for (const row of await listOrgLinkedRepositories(input.orgId)) {
    if (normalizeWorkspaceRepositoryUrl(row.gitUrl) !== url) continue
    const binding = await getLinkedReadBinding(row.id)
    if (binding?.sha && binding.repositoryId === input.repositoryId)
      linked.push(linkedRevisionSchema.parse(binding))
  }
  return { owners, linked }
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
  return orgSql(() => listLinkedRepositoryPins(getOrgDb(), { orgId }))
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

export async function listLinkedRepositories(workspaceId: string): Promise<
  Array<
    WorkspaceLinkedRepositoryRecord & {
      indexingStatus: string | null
      indexingError: string | null
    }
  >
> {
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
    const [linked, indexed] = await Promise.all([
      listLinkedRepositoryPins(db, { workspaceId }),
      db
        .select({
          gitUrl: repositories.gitUrl,
          indexingStatus: repositories.indexingStatus,
          indexingError: repositories.indexingError,
        })
        .from(repositories)
        .where(eq(repositories.orgId, workspace.orgId)),
    ])
    // The org repository row carries index health (e.g. complete_with_issues).
    const health = new Map(
      indexed.map((row) => [normalizeWorkspaceRepositoryUrl(row.gitUrl), row]),
    )
    return linked.map((row) => {
      const repository = health.get(normalizeWorkspaceRepositoryUrl(row.gitUrl))
      return {
        ...row,
        indexingStatus: repository?.indexingStatus ?? null,
        indexingError: repository?.indexingError ?? null,
      }
    })
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

/**
 * The paths of `paths` that are main-era knowledge units of the Workspace
 * (source `legacy`), with their body: hydrate serves them from Postgres, and
 * git does not have them. With no `paths`, at most one such unit.
 */
export async function legacyKnowledgePaths(
  workspaceId: string,
  paths?: readonly string[],
): Promise<Map<string, string>> {
  if (paths && paths.length === 0) return new Map()
  const rows = await orgSql(() =>
    getOrgDb()
      .select({
        path: workspaceKnowledgeUnits.path,
        body: workspaceKnowledgeUnits.body,
      })
      .from(workspaceKnowledgeUnits)
      .where(
        and(
          eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
          eq(workspaceKnowledgeUnits.source, LEGACY_UNIT_SOURCE),
          paths ? inArray(workspaceKnowledgeUnits.path, [...paths]) : undefined,
        ),
      )
      .limit(paths ? paths.length : 1),
  )
  return new Map(rows.map((row) => [row.path, row.body]))
}

/**
 * True when a write to `paths` changes a main-era knowledge unit of the
 * Workspace. Each path is made canonical before the check (no padding, no
 * `./` part and no empty part), so that another spelling of a path cannot go
 * past the check. Every writer (the Files job, the conversation file route
 * and the conversation publish) calls this one function.
 */
export async function writesLegacyKnowledge(
  workspaceId: string,
  paths: ReadonlyArray<string | null | undefined>,
): Promise<boolean> {
  const canonical = new Set(
    paths.flatMap((path) => {
      const parts = (path ?? "")
        .replaceAll("\\", "/")
        .split("/")
        .map((part) => part.trim())
        .filter((part) => part !== "" && part !== ".")
      return parts.length ? [parts.join("/")] : []
    }),
  )
  return (await legacyKnowledgePaths(workspaceId, [...canonical])).size > 0
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
        kind: workspaceKnowledgeUnits.kind,
        title: workspaceKnowledgeUnits.title,
        source: workspaceKnowledgeUnits.source,
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
        kind: row.kind,
        title: row.title,
        source: row.source ?? "authored",
        updatedAt: row.updatedAt.toISOString(),
        body: row.body,
        links: row.links,
        claims: row.claims,
      })),
      lastUpdatedAt: lastUpdatedAt?.toISOString() ?? null,
    }
  })
}

/**
 * The number of knowledge units in each top-level folder of the active
 * projection, largest first, at most `limit` folders. `""` holds the files at
 * the Workspace root. Each row also has the totals of all folders. The
 * database groups the rows, so a Workspace with many files sends only one
 * small row for each folder.
 */
export async function workspaceKnowledgeFolderCounts(
  workspaceId: string,
  limit: number,
): Promise<
  Array<{ folder: string; files: number; folders: number; total: number }>
> {
  return orgSql(async () => {
    const folder = sql<string>`case when strpos(${workspaceKnowledgeUnits.path}, '/') > 0 then split_part(${workspaceKnowledgeUnits.path}, '/', 1) else '' end`
    const files = sql<number>`count(*)::int`
    return getOrgDb()
      .select({
        folder,
        files,
        folders: sql<number>`(count(*) over ())::int`,
        total: sql<number>`(sum(count(*)) over ())::int`,
      })
      .from(workspaceKnowledgeUnits)
      .innerJoin(
        workspaces,
        eq(workspaces.id, workspaceKnowledgeUnits.workspaceId),
      )
      .where(
        and(
          eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
          sql`${workspaceKnowledgeUnits.projectionSha} = coalesce(${workspaces.activeRevision}->>'sha', ${workspaces.activeProjectionSha})`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(desc(files), asc(folder))
      .limit(limit)
  })
}

/** Paths, kinds, and links of the units projected at one revision, in path order. */
export async function listWorkspaceUnitsAtRevision(
  workspaceId: string,
  sha: string,
): Promise<Array<{ path: string; kind: string | null; links: string[] }>> {
  return orgSql(async () =>
    getOrgDb()
      .select({
        path: workspaceKnowledgeUnits.path,
        kind: workspaceKnowledgeUnits.kind,
        links: workspaceKnowledgeUnits.links,
      })
      .from(workspaceKnowledgeUnits)
      .where(
        and(
          eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
          eq(workspaceKnowledgeUnits.projectionSha, sha),
        ),
      )
      .orderBy(workspaceKnowledgeUnits.path),
  )
}

/**
 * The Workspace format (ADR-053) that hydrate cached for the binding of
 * `revision`, or 0. The cache belongs to the active projection, so a
 * projection of another binding (or no projection) gives 0. Only an upgrade
 * pull request changes the format, so a newer SHA of the same binding has
 * the same format until hydrate reads that SHA.
 */
export async function getBindingWorkspaceFormat(
  revision: WorkspaceRevision,
): Promise<number> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select({
        activeRevision: workspaces.activeRevision,
        formatVersion: workspaces.formatVersion,
      })
      .from(workspaces)
      .where(eq(workspaces.id, revision.workspaceId))
      .limit(1)
    return row && sameWorkspaceBinding(row.activeRevision, revision)
      ? (row.formatVersion ?? 0)
      : 0
  })
}

export async function commitHydrateProjection(input: {
  orgId: string
  revision: WorkspaceRevision
  displayName: string | null
  /** The cache value of the format file at the revision (`workspace-format.ts`). Null: no format yet. */
  formatVersion: number | null
  units: readonly HydrateUnit[]
  skipped: readonly HydrateSkip[]
  /** Part of each chunk hash, so that a model change embeds again. */
  embeddingModel: string
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
          formatVersion: input.formatVersion,
          hydratePhases: sql`${JSON.stringify({
            ...initialHydratePhases({
              url: input.revision.remote.url,
              sha: input.revision.sha,
              revision: input.revision,
            }),
            skipped: input.skipped,
          })}::jsonb || jsonb_build_object('publishedIndex', coalesce(
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
      const now = new Date()
      // Postgres caps bind parameters at 65,535; ~13 per unit row.
      for (let start = 0; start < input.units.length; start += 500) {
        await tx.insert(workspaceKnowledgeUnits).values(
          input.units.slice(start, start + 500).map((unit) => ({
            servingId: unit.servingId,
            orgId: input.orgId,
            workspaceId: input.revision.workspaceId,
            path: unit.path,
            kind: unit.kind ?? null,
            title: unit.title ?? null,
            source: unit.source ?? null,
            body: unit.body,
            projectionSha: input.revision.sha,
            links: unit.links,
            claims: unit.claims,
            createdAt: now,
            updatedAt: unit.updatedAt ? new Date(unit.updatedAt) : now,
          })),
        )
      }
      await replaceKnowledgeChunks(tx, {
        orgId: input.orgId,
        workspaceId: input.revision.workspaceId,
        rows: knowledgeChunkRows(input.units, input.embeddingModel),
      })

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
  await orgSql(() =>
    clearLinkedRepositoryShas(
      getOrgDb(),
      urls,
      normalizeWorkspaceRepositoryUrl,
    ),
  )
}

/**
 * Connection deletion is a relink, not an implicit foreign-key metadata edit.
 * No job can read without the connection, so hydrate fails until a reconnect rebinds.
 */
export async function detachWorkspaceConnection(
  connectionId: string,
): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaces)
      .set({
        ...nextRelinkFields(0, {
          writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
          readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
        }),
        desiredGeneration: sql`${workspaces.desiredGeneration} + 1`,
        githubConnectionId: null,
        hydrateStatus: "failed",
        hydrateError:
          "The GitHub connection was removed. Reconnect GitHub to restore this workspace.",
        updatedAt: new Date(),
      })
      .where(eq(workspaces.githubConnectionId, connectionId))
  })
}

/** Workspaces with no GitHub connection: detached by a disconnect, or added by Paste. */
export async function listUnboundWorkspaces(): Promise<WorkspaceRecord[]> {
  const rows = await orgSql(() =>
    getOrgDb()
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, requireCurrentOrgId()),
          sql`${workspaces.githubConnectionId} is null`,
        ),
      ),
  )
  return rows.map(withFormatWriteGate)
}

/** Bind only while the row is still unbound at the read generation, so a concurrent relink wins. */
export async function bindUnboundWorkspace(input: {
  workspace: WorkspaceRecord
  githubConnectionId: string
}): Promise<WorkspaceRecord | null> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        ...nextRelinkFields(
          input.workspace.desiredGeneration,
          writeStatusFromClassification({
            workspaceRepositoryUrl: input.workspace.workspaceRepositoryUrl,
            githubConnectionId: input.githubConnectionId,
          }),
        ),
        githubConnectionId: input.githubConnectionId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, input.workspace.id),
          eq(workspaces.desiredGeneration, input.workspace.desiredGeneration),
          sql`${workspaces.githubConnectionId} is null`,
        ),
      )
      .returning()
    return updated ?? null
  })
}

/** Capture the owner, linked ref and connection in one database transaction. */
export async function getLinkedReadBinding(
  linkId: string,
): Promise<LinkedReadBinding | null> {
  return orgSql(() =>
    getOrgDb().transaction(async (tx) => {
      const linked = await getLinkedRepositoryPin(tx, linkId)
      if (!linked) return null
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, linked.workspaceId))
      if (!workspace) return null
      const candidates = await tx
        .select()
        .from(repositories)
        .where(eq(repositories.orgId, workspace.orgId))
      const repository = candidates.find(
        (row) =>
          normalizeWorkspaceRepositoryUrl(row.gitUrl) ===
          normalizeWorkspaceRepositoryUrl(linked.gitUrl),
      )
      if (!repository) return null
      const owner = desiredWorkspaceRevision(workspace)
      if (!owner) return null
      return {
        owner,
        linkId: linked.id,
        repositoryId: repository.id,
        remote: {
          url: linked.gitUrl,
          connectionId: repository.githubConnectionId,
        },
        ref: linked.desiredRef,
        sha: linked.desiredSha,
      }
    }),
  )
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

type OrgTx = Parameters<
  Parameters<ReturnType<typeof getOrgDb>["transaction"]>[0]
>[0]

/**
 * The binding still holds: the same pin (Workspace, URL, ref, SHA), the
 * owner at its desired revision, and the repository on the same connection.
 */
async function linkedBindingHolds(
  tx: OrgTx,
  binding: LinkedReadBinding,
  pin: LinkedRepositoryPin,
  ownerPredicate: SQL | undefined = desiredRevisionPredicate(binding.owner),
): Promise<boolean> {
  if (
    pin.workspaceId !== binding.owner.workspaceId ||
    pin.gitUrl !== binding.remote.url ||
    pin.desiredRef !== binding.ref ||
    pin.desiredSha !== binding.sha
  )
    return false
  const [owner] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(ownerPredicate)
  if (!owner) return false
  const [repository] = await tx
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.id, binding.repositoryId),
        sql`${repositories.githubConnectionId} is not distinct from ${binding.remote.connectionId}`,
      ),
    )
  return Boolean(repository)
}

export async function persistLinkedDesiredSha(input: {
  binding: LinkedReadBinding
  resolvedTip: string
}): Promise<boolean> {
  const revision = linkedRevisionSchema.parse({
    ...input.binding,
    sha: input.resolvedTip,
  })
  return orgSql(() =>
    updateLinkedRepositoryPin(
      getOrgDb(),
      input.binding.linkId,
      async (pin, tx) =>
        (await linkedBindingHolds(tx, input.binding, pin))
          ? { desiredSha: revision.sha }
          : null,
    ),
  )
}

export async function persistLinkedIndexedSha(
  revision: LinkedRevision,
): Promise<boolean> {
  return orgSql(() =>
    updateLinkedRepositoryPin(getOrgDb(), revision.linkId, async (pin, tx) =>
      (await linkedBindingHolds(
        tx,
        revision,
        pin,
        and(
          desiredRevisionPredicate(revision.owner),
          sql`${workspaces.activeRevision} = ${JSON.stringify(revision.owner)}::jsonb`,
        ),
      ))
        ? { indexedSha: revision.sha }
        : null,
    ),
  )
}

async function getOrgFirstWorkspace(orgId: string): Promise<{
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

/**
 * Record the first Workspace of an org when it has none: after the first one
 * is deleted, or for an org that the SQL migration did not cover. It prefers
 * the Workspace of the oldest org repository with the same URL, else the
 * oldest Workspace. It never adds or removes a link.
 */
export async function ensureOrgFirstWorkspace(orgId: string): Promise<void> {
  return orgSql(async () => {
    if (await getOrgFirstWorkspace(orgId)) return
    const [workspaceRows, repositoryRows] = await Promise.all([
      getOrgDb()
        .select({
          id: workspaces.id,
          workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
        })
        .from(workspaces)
        .where(eq(workspaces.orgId, orgId))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id)),
      getOrgDb()
        .select({
          id: repositories.id,
          gitUrl: repositories.gitUrl,
          createdAt: repositories.createdAt,
        })
        .from(repositories)
        .where(eq(repositories.orgId, orgId)),
    ])
    const workspaceByUrl = new Map(
      workspaceRows.map((row) => [
        normalizeWorkspaceRepositoryUrl(row.workspaceRepositoryUrl),
        row,
      ]),
    )
    const source = firstConnectorTarget(
      repositoryRows.filter((repo) =>
        workspaceByUrl.has(normalizeWorkspaceRepositoryUrl(repo.gitUrl)),
      ),
    )
    const workspace = source
      ? workspaceByUrl.get(normalizeWorkspaceRepositoryUrl(source.gitUrl))
      : workspaceRows[0]
    if (!workspace) return
    await persistOrgFirstWorkspace({
      orgId,
      workspaceId: workspace.id,
      // The column is not null; no repository has this Workspace's URL.
      sourceRepositoryId: source?.id ?? "",
    })
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

/** Clear a failed write-access check so the UI shows a new check in progress. */
export async function persistWriteCheckRetry(
  workspaceId: string,
): Promise<WorkspaceRecord | undefined> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({ readOnlyReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.writeStatus, "unknown"),
        ),
      )
      .returning()
    return updated
  })
}

/** Remote permission results apply only to the exact binding that was probed. */
export async function persistWriteStatus(
  expected: WorkspaceWriteProbeBinding,
  write: WorkspaceWriteProbe,
  orgId: string,
): Promise<boolean> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        writeStatus: write.writeStatus,
        readOnlyReason: write.readOnlyReason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, expected.id),
          eq(workspaces.orgId, orgId),
          eq(workspaces.desiredGeneration, expected.desiredGeneration),
          eq(
            workspaces.workspaceRepositoryUrl,
            expected.workspaceRepositoryUrl,
          ),
          sql`${workspaces.githubConnectionId} is not distinct from ${expected.githubConnectionId}`,
          sql`${workspaces.desiredDefaultBranch} is not distinct from ${expected.desiredDefaultBranch}`,
          sql`${workspaces.desiredSha} is not distinct from ${expected.desiredSha}`,
        ),
      )
      .returning({ id: workspaces.id })
    return !!updated
  })
}

/**
 * The new record of a derived phase. A failure keeps the time of the first
 * failure of the same revision, and a retry (`pending`) keeps the whole
 * failure, so that a crash in the retry loses neither. A success clears it.
 */
function derivedPhaseSql(
  key: "graph" | "index",
  input: { revision: WorkspaceRevision; result: DerivedStoreResult },
) {
  const revision = JSON.stringify(input.revision)
  const record = sql`jsonb_build_object('revision', ${revision}::jsonb, 'result', ${JSON.stringify(input.result)}::jsonb)`
  if (input.result.kind === "ready") return record
  const phase = sql`${workspaces.hydratePhases}->${sql.raw(`'${key}'`)}`
  const prior = sql`case when ${phase}->'revision' = ${revision}::jsonb then ${phase}->'failure' end`
  const failure =
    input.result.kind === "failed"
      ? sql`jsonb_build_object('message', ${input.result.message}::text, 'at', coalesce(${prior}->>'at', ${new Date().toISOString()}::text))`
      : prior
  return sql`${record} || case when ${failure} is null then '{}'::jsonb else jsonb_build_object('failure', ${failure}) end`
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
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || jsonb_build_object('index', ${derivedPhaseSql("index", input)}) || ${JSON.stringify(
          input.result.kind === "ready"
            ? { publishedIndex: input.revision }
            : {},
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

/** SQL: the unit has text but no chunk row. */
function unitWithoutChunks(workspaceId: SQL, servingId: SQL, body: SQL) {
  return sql`btrim(${body}, E' \t\r\n') <> '' and not exists (
    select 1 from workspace_knowledge_chunks as c
    where c.workspace_id = ${workspaceId} and c.unit_id = ${servingId}
  )`
}

type OrgTransaction = Parameters<
  Parameters<ReturnType<typeof getOrgDb>["transaction"]>[0]
>[0]

/**
 * Make the Workspace's chunk rows match one projection, in the transaction
 * that activates it. Unchanged chunks get no write. A changed position gets an
 * update of its line columns only. A new chunk copies the embedding of a chunk
 * with the same hash before gone chunks are deleted, so hydrate never embeds
 * an unchanged chunk again.
 */
async function replaceKnowledgeChunks(
  tx: OrgTransaction,
  input: { orgId: string; workspaceId: string; rows: KnowledgeChunkRow[] },
) {
  const chunks = workspaceKnowledgeChunks
  const key = (row: {
    unitId: string
    chunkHash: string
    occurrence: number
  }) => `${row.unitId}\0${row.chunkHash}\0${row.occurrence}`
  const existing = new Map(
    (
      await tx
        .select({
          unitId: chunks.unitId,
          chunkHash: chunks.chunkHash,
          occurrence: chunks.occurrence,
          ordinal: chunks.ordinal,
          startLine: chunks.startLine,
          endLine: chunks.endLine,
        })
        .from(chunks)
        .where(eq(chunks.workspaceId, input.workspaceId))
    ).map((row) => [key(row), row]),
  )
  const added: KnowledgeChunkRow[] = []
  const moved: KnowledgeChunkRow[] = []
  for (const row of input.rows) {
    const old = existing.get(key(row))
    existing.delete(key(row))
    if (!old) added.push(row)
    else if (
      old.ordinal !== row.ordinal ||
      old.startLine !== row.startLine ||
      old.endLine !== row.endLine
    )
      moved.push(row)
  }
  const gone = [...existing.values()]
  const keyTuple = (row: {
    unitId: string
    chunkHash: string
    occurrence: number
  }) => sql`(${row.unitId}, ${row.chunkHash}, ${row.occurrence}::integer)`

  // Nine bind parameters per row; chunk text is at most a few kilobytes.
  for (let start = 0; start < added.length; start += 1000) {
    await tx.insert(chunks).values(
      added.slice(start, start + 1000).map((row) => ({
        ...row,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      })),
    )
  }
  if (added.length > 0)
    await tx.execute(sql`
      UPDATE workspace_knowledge_chunks AS n
      SET embedding = o.embedding
      FROM workspace_knowledge_chunks AS o
      WHERE n.workspace_id = ${input.workspaceId}
        AND n.embedding IS NULL
        AND o.workspace_id = ${input.workspaceId}
        AND o.chunk_hash = n.chunk_hash
        AND o.embedding IS NOT NULL
    `)
  for (let start = 0; start < moved.length; start += 1000) {
    const values = moved
      .slice(start, start + 1000)
      .map(
        (row) =>
          sql`(${row.unitId}, ${row.chunkHash}, ${row.occurrence}::integer, ${row.ordinal}::integer, ${row.startLine}::integer, ${row.endLine}::integer)`,
      )
    await tx.execute(sql`
      UPDATE workspace_knowledge_chunks AS c
      SET ordinal = v.ordinal, start_line = v.start_line, end_line = v.end_line
      FROM (VALUES ${sql.join(values, sql`, `)})
        AS v(unit_id, chunk_hash, occurrence, ordinal, start_line, end_line)
      WHERE c.workspace_id = ${input.workspaceId}
        AND c.unit_id = v.unit_id
        AND c.chunk_hash = v.chunk_hash
        AND c.occurrence = v.occurrence
    `)
  }
  for (let start = 0; start < gone.length; start += 1000) {
    await tx.execute(sql`
      DELETE FROM workspace_knowledge_chunks
      WHERE workspace_id = ${input.workspaceId}
        AND (unit_id, chunk_hash, occurrence) IN (${sql.join(
          gone.slice(start, start + 1000).map(keyTuple),
          sql`, `,
        )})
    `)
  }
}

/**
 * Embed the Workspace's chunks that have no embedding, one batch of distinct
 * hashes at a time. The model call runs outside the org database context.
 */
export async function embedKnowledgeChunks(input: {
  workspaceId: string
  embed: (texts: string[]) => Promise<number[][]>
}): Promise<void> {
  const chunks = workspaceKnowledgeChunks
  for (;;) {
    const pending = await orgSql(() =>
      getOrgDb()
        .selectDistinctOn([chunks.chunkHash], {
          chunkHash: chunks.chunkHash,
          text: chunks.text,
        })
        .from(chunks)
        .where(
          and(
            eq(chunks.workspaceId, input.workspaceId),
            sql`${chunks.embedding} is null`,
          ),
        )
        .orderBy(chunks.chunkHash)
        .limit(64),
    )
    if (pending.length === 0) return
    const vectors = await input.embed(pending.map((chunk) => chunk.text))
    if (vectors.length !== pending.length)
      throw new Error(
        `Expected ${pending.length} embeddings, got ${vectors.length}`,
      )
    const updated = await orgSql(() =>
      getOrgDb().execute(sql`
        UPDATE workspace_knowledge_chunks AS c
        SET embedding = v.embedding::vector
        FROM jsonb_to_recordset(${JSON.stringify(
          pending.map((chunk, index) => ({
            chunk_hash: chunk.chunkHash,
            embedding: JSON.stringify(vectors[index]),
          })),
        )}::jsonb) AS v(chunk_hash text, embedding text)
        WHERE c.workspace_id = ${input.workspaceId}
          AND c.chunk_hash = v.chunk_hash
          AND c.embedding IS NULL
      `),
    )
    // Another activation replaced these chunks. Stop, so that the loop cannot
    // pay for the same texts again.
    if (!updated.rowCount)
      throw new Error("Knowledge chunks changed during embedding")
  }
}

/**
 * Mark the embeddings of the active revision ready. Refuses while a chunk has
 * no embedding or a unit with text has no chunk.
 */
export async function markKnowledgeEmbeddingsReady(input: {
  revision: WorkspaceRevision
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
      const [incomplete] = (
        await tx.execute<{ incomplete: boolean }>(sql`
          SELECT exists (
            SELECT 1 FROM workspace_knowledge_chunks
            WHERE workspace_id = ${input.revision.workspaceId}
              AND embedding IS NULL
          ) OR exists (
            SELECT 1 FROM workspace_knowledge_units AS u
            WHERE u.workspace_id = ${input.revision.workspaceId}
              AND u.projection_sha = ${input.revision.sha}
              AND ${unitWithoutChunks(sql`u.workspace_id`, sql`u.serving_id`, sql`u.body`)}
          ) AS incomplete
        `)
      ).rows
      if (incomplete?.incomplete)
        throw new Error("Knowledge chunks are not all embedded")
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
/**
 * Set a ready graph phase back to pending when the graph store lost that graph.
 * Only one caller wins for each loss, so only that caller starts the rebuild.
 * Returns the time of the change, or null when another caller already won.
 */
export async function markWorkspaceGraphLost(
  revision: WorkspaceRevision,
): Promise<Date | null> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || ${JSON.stringify({ graph: { revision, result: { kind: "pending" } } })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, revision.workspaceId),
          sql`${workspaces.activeRevision} = ${JSON.stringify(revision)}::jsonb`,
          sql`${workspaces.hydratePhases}->'graph'->'revision' = ${JSON.stringify(revision)}::jsonb`,
          sql`${workspaces.hydratePhases}->'graph'->'result'->>'kind' = 'ready'`,
        ),
      )
      .returning({ updatedAt: workspaces.updatedAt })
    return updated?.updatedAt ?? null
  })
}

/**
 * Set a failed graph phase of the active revision back to pending for a
 * manual rebuild. The phase keeps its first failure, so the tip check spaces
 * out its retries from that time. The queued run can start and fail again
 * before this write, so the write occurs only when the row is the row that
 * the caller read at `readAt`.
 */
export async function markWorkspaceGraphRetry(
  revision: WorkspaceRevision,
  readAt: Date,
): Promise<void> {
  await orgSql(() =>
    getOrgDb()
      .update(workspaces)
      .set({
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || jsonb_build_object('graph', ${derivedPhaseSql("graph", { revision, result: { kind: "pending" } })})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.id, revision.workspaceId),
          sql`${workspaces.activeRevision} = ${JSON.stringify(revision)}::jsonb`,
          sql`${workspaces.hydratePhases}->'graph'->'revision' = ${JSON.stringify(revision)}::jsonb`,
          sql`${workspaces.hydratePhases}->'graph'->'result'->>'kind' = 'failed'`,
          // A JavaScript date has milliseconds; the column has microseconds.
          sql`date_trunc('milliseconds', ${workspaces.updatedAt}) = ${readAt.toISOString()}::timestamptz`,
        ),
      ),
  )
}

export async function persistWorkspaceGraphResult(input: {
  revision: WorkspaceRevision
  result: DerivedStoreResult
}): Promise<boolean> {
  return orgSql(async () => {
    const [updated] = await getOrgDb()
      .update(workspaces)
      .set({
        hydratePhases: sql`coalesce(${workspaces.hydratePhases}, '{}'::jsonb) || jsonb_build_object('graph', ${derivedPhaseSql("graph", input)})`,
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
