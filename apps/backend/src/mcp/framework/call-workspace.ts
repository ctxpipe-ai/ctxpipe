import { and, asc, eq, sql } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { githubScopeSchema } from "../../domain/workspace-sources/providers/github.js"
import { workspaceRevisionSchema } from "../../domain/workspaces/revision.js"
import { isValidSlug } from "../../domain/workspaces/slug.js"
import { RepositoryHandles } from "./repository-handles.js"
import { McpToolError, workspaceNotFound } from "./tool-errors.js"
import type { CallOrg } from "./tool-org.js"

/** The branch and SHA that a response serves (ADR-051 §5). */
export type Served = { branch: string; sha: string }

export type CallWorkspace = {
  id: string
  slug: string
  title: string
  /** Null until the first projection is published. */
  served: Served | null
}

/**
 * The Workspace that the `workspace` argument names, in the org of the call.
 * The query runs under the RLS context of that org, so a Workspace of
 * another org and an unknown Workspace give the same error.
 */
export async function resolveCallWorkspace(
  org: CallOrg,
  slug: string,
): Promise<CallWorkspace> {
  const wanted = slug.trim().toLowerCase()
  if (!isValidSlug(wanted)) throw workspaceNotFound(org.slug, slug)
  const [row] = await withOrgDbContext(org.id, (db) =>
    db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        displayName: workspaces.displayName,
        activeRevision: workspaces.activeRevision,
        activeProjectionSha: workspaces.activeProjectionSha,
        desiredDefaultBranch: workspaces.desiredDefaultBranch,
      })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, org.id),
          sql`lower(${workspaces.slug}) = ${wanted}`,
        ),
      )
      .limit(1),
  )
  if (!row) throw workspaceNotFound(org.slug, slug)
  const revision = workspaceRevisionSchema.safeParse(row.activeRevision)
  const served: Served | null = revision.success
    ? { branch: revision.data.defaultBranch, sha: revision.data.sha }
    : row.activeProjectionSha && row.desiredDefaultBranch
      ? { branch: row.desiredDefaultBranch, sha: row.activeProjectionSha }
      : null
  return { id: row.id, slug: row.slug, title: row.displayName, served }
}

/** The served revision, or `workspace_not_ready` (retryable) before the first one. */
export function requireServed(workspace: CallWorkspace): Served {
  if (workspace.served) return workspace.served
  throw new McpToolError(
    "workspace_not_ready",
    `Workspace "${workspace.slug}" has no published revision yet. Try again in a few minutes.`,
  )
}

/** Workspace slugs of one org, in slug order. */
export async function listOrgWorkspaceSlugs(org: CallOrg): Promise<string[]> {
  const rows = await withOrgDbContext(org.id, (db) =>
    db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.orgId, org.id))
      .orderBy(asc(workspaces.slug)),
  )
  return rows.map((row) => row.slug)
}

/**
 * Every repository link of the org: the Workspace and the git URL, oldest
 * first. Two stores hold links during the ADR-050 migration: the GitHub
 * sources of `.ctxpipe/sources.yaml` (the `workspace_sources` projection,
 * `ok` rows only) and the legacy `workspace_linked_repositories` table, which
 * ADR-050 phase 3 retires. Only this function reads them. With
 * `workspaceId`, only the links of that Workspace.
 */
export async function listOrgRepositoryLinks(
  org: CallOrg,
  workspaceId?: string,
): Promise<Array<{ workspaceId: string; gitUrl: string }>> {
  const [legacy, sources] = await withOrgDbContext(org.id, (db) =>
    Promise.all([
      db
        .select({
          workspaceId: workspaceLinkedRepositories.workspaceId,
          gitUrl: workspaceLinkedRepositories.gitUrl,
        })
        .from(workspaceLinkedRepositories)
        .where(
          and(
            eq(workspaceLinkedRepositories.orgId, org.id),
            workspaceId
              ? eq(workspaceLinkedRepositories.workspaceId, workspaceId)
              : undefined,
          ),
        )
        .orderBy(asc(workspaceLinkedRepositories.createdAt)),
      db
        .select({
          workspaceId: workspaceSources.workspaceId,
          scope: workspaceSources.scope,
        })
        .from(workspaceSources)
        .where(
          and(
            eq(workspaceSources.orgId, org.id),
            eq(workspaceSources.provider, "github"),
            eq(workspaceSources.status, "ok"),
            workspaceId
              ? eq(workspaceSources.workspaceId, workspaceId)
              : undefined,
          ),
        )
        .orderBy(asc(workspaceSources.createdAt)),
    ]),
  )
  const fromSources = sources.flatMap((row) => {
    const scope = githubScopeSchema.safeParse(row.scope)
    return scope.success
      ? scope.data.repositories.map((name) => ({
          workspaceId: row.workspaceId,
          gitUrl: `https://github.com/${name}`,
        }))
      : []
  })
  return [...legacy, ...fromSources]
}

/** Git URLs of the repository links of the org, or of one Workspace. */
export async function listOrgRepositoryUrls(
  org: CallOrg,
  workspaceId?: string,
): Promise<string[]> {
  return (await listOrgRepositoryLinks(org, workspaceId)).map(
    (link) => link.gitUrl,
  )
}

/**
 * Handles for every repository that a Workspace of the org links. Handles
 * are unique in the org, so a ref from one Workspace is valid in another
 * Workspace that links the same repository.
 */
export async function loadOrgRepositoryHandles(
  org: CallOrg,
): Promise<RepositoryHandles> {
  return RepositoryHandles.from(await listOrgRepositoryUrls(org))
}

/**
 * The handles of the links of one Workspace, from the org-level `handles`.
 * `invalid` is true when a stored URL has no handle, because it does not
 * parse as a git address; the URL is left out and never echoed.
 */
export function workspaceLinkHandles(
  handles: RepositoryHandles,
  links: ReadonlyArray<{ gitUrl: string }>,
): { linked: Set<string>; invalid: boolean } {
  const linked = new Set<string>()
  let invalid = false
  for (const link of links) {
    try {
      linked.add(handles.resolve(link.gitUrl).handle)
    } catch (error) {
      if (!(error instanceof McpToolError)) throw error
      invalid = true
    }
  }
  return { linked, invalid }
}

/** The org-level handles, and the handles that one Workspace links. */
export async function loadWorkspaceHandles(
  org: CallOrg,
  workspaceId: string,
): Promise<{
  handles: RepositoryHandles
  linked: Set<string>
  invalid: boolean
}> {
  const links = await listOrgRepositoryLinks(org)
  const handles = RepositoryHandles.from(links.map((link) => link.gitUrl))
  return {
    handles,
    ...workspaceLinkHandles(
      handles,
      links.filter((link) => link.workspaceId === workspaceId),
    ),
  }
}
