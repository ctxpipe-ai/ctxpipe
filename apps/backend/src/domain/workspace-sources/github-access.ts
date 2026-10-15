import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { findRepositoriesByNormalizedGitUrls } from "../../models/repositories.js"
import { recordSourceAccessCheck } from "../../models/workspace-sources.js"
import { ensureOrgRepositoryForGitUrl } from "../workspaces/ensure-org-repository.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubSourceScopeRepositories } from "./providers/github.js"

function githubUrl(repositoryName: string): string {
  return normalizeWorkspaceRepositoryUrl(`https://github.com/${repositoryName}`)
}

/**
 * The access check of a GitHub source (ADR-050). GitHub mirrors no files:
 * hydrate links the repositories of each GitHub source, and the tip check
 * and the index clone them. So GitHub has no sync adapter, only this check.
 *
 * It binds the org repository row of each repository to the source's
 * connection when GitHub confirms read access, so the tip check and the index
 * read with that connection's token. GitHub clears the binding when the
 * connection cannot read the repository. The check names those repositories;
 * the row becomes `out_of_access`. Call it inside the org context
 * (`withOrgIdContext`), as hydrate does.
 */
export async function checkGithubSourceAccess(input: {
  orgId: string
  connectionId: string
  scope: Record<string, unknown>
}): Promise<string | null> {
  const repositories = githubSourceScopeRepositories(input.scope)
  const missing: string[] = []
  for (const { name } of repositories) {
    const repository = await ensureOrgRepositoryForGitUrl({
      orgId: input.orgId,
      gitUrl: githubUrl(name),
      githubConnectionId: input.connectionId,
    })
    if (repository?.coverage === "foreign") missing.push(name)
  }
  return missing.length
    ? `ctx| has no access to these repositories: ${missing.join(", ")}. Add them to the GitHub App installation of this connection.`
    : null
}

/**
 * How long the tip check waits before it checks an `out_of_access` source
 * again. Nothing else checks again when an admin adds a repository to the
 * installation (the deployment App sends no per-connection webhook), so
 * without it a source stays `out_of_access` until its next commit.
 */
const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * The linked repositories (`<workspaceId> <url>`) that the tip check skips:
 * each repository of an `out_of_access` GitHub source that no connection can
 * read (its org repository row has no binding). A row last checked more than
 * six hours ago is checked again first. Call it inside the org context.
 */
export async function githubRepositoriesWithoutAccess(input: {
  orgId: string
  env: Env
  now: Date
}): Promise<Set<string>> {
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .select()
      .from(workspaceSources)
      .where(
        and(
          eq(workspaceSources.provider, "github"),
          eq(workspaceSources.status, "out_of_access"),
        ),
      ),
  )
  const still: Array<{ workspaceId: string; urls: string[] }> = []
  for (const row of rows) {
    const repositories = githubSourceScopeRepositories(row.scope)
    if (!repositories.length) continue
    let detail = row.statusDetail
    if (
      row.connectionId &&
      input.now.getTime() - row.updatedAt.getTime() >= RECHECK_AFTER_MS
    ) {
      detail = await checkGithubSourceAccess({
        orgId: input.orgId,
        connectionId: row.connectionId,
        scope: row.scope,
      })
      await recordSourceAccessCheck({
        orgId: input.orgId,
        id: row.id,
        revision: row.revision,
        status: detail ? "out_of_access" : "ok",
        statusDetail: detail,
      })
    }
    if (detail)
      still.push({
        workspaceId: row.workspaceId,
        urls: repositories.map(({ name }) => githubUrl(name)),
      })
  }
  const unbound = new Set(
    (
      await withOrgDbContext(input.orgId, () =>
        findRepositoriesByNormalizedGitUrls(still.flatMap((row) => row.urls)),
      )
    )
      .filter((repository) => repository.githubConnectionId === null)
      .map((repository) => normalizeWorkspaceRepositoryUrl(repository.gitUrl)),
  )
  return new Set(
    still.flatMap((row) =>
      row.urls
        .filter((url) => unbound.has(url))
        .map((url) => `${row.workspaceId} ${url}`),
    ),
  )
}
