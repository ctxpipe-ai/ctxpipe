import { and, eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaceLinkedRepositories } from "../../db/schema/workspaces.js"
import { getWorkspaceGithubReadToken } from "../../models/github-installation.js"
import { verifyWorkspaceChatRunCapability } from "./workspace-chat-run-capability.js"

/** Git credential-protocol inputs name an exact HTTPS GitHub repository. */
export function workspaceChatGithubRepository(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return undefined
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      parsed.pathname,
    )
    if (
      !match?.[1] ||
      !match[2] ||
      [match[1], match[2]].some((part) => part === "." || part === "..")
    )
      return undefined
    return `${match[1]}/${match[2]}`.toLowerCase()
  } catch {
    return undefined
  }
}

export async function resolveWorkspaceChatGitCredential(input: {
  env: Env
  capability: string
  repositoryUrl?: string
}): Promise<
  | { ok: true; username: "x-access-token"; password: string }
  | { ok: false; status: 401 | 403 | 503; error: string }
> {
  const authority = {
    authSecret: input.env.AUTH_SECRET,
    token: input.capability,
    purpose: "workspace-chat-git" as const,
  }
  const claims = await verifyWorkspaceChatRunCapability(authority)
  if (!claims) return { ok: false, status: 401, error: "Unauthorized" }
  const connectionId = claims.revision.remote.connectionId
  if (!connectionId)
    return {
      ok: false,
      status: 403,
      error: "No workspace GitHub read connection",
    }
  const readScope = async () => {
    const linked = await withOrgDbContext(claims.orgId, (db) =>
      db
        .select({ url: workspaceLinkedRepositories.gitUrl })
        .from(workspaceLinkedRepositories)
        .innerJoin(
          repositories,
          and(
            eq(repositories.gitUrl, workspaceLinkedRepositories.gitUrl),
            eq(repositories.orgId, workspaceLinkedRepositories.orgId),
            eq(repositories.githubConnectionId, connectionId),
          ),
        )
        .where(
          and(
            eq(workspaceLinkedRepositories.orgId, claims.orgId),
            eq(
              workspaceLinkedRepositories.workspaceId,
              claims.revision.workspaceId,
            ),
          ),
        ),
    )
    return [
      ...new Set(
        [claims.revision.remote.url, ...linked.map((entry) => entry.url)]
          .map(workspaceChatGithubRepository)
          .filter((name): name is string => !!name),
      ),
    ].sort()
  }
  const names = await readScope()
  const requested =
    input.repositoryUrl === undefined
      ? undefined
      : workspaceChatGithubRepository(input.repositoryUrl)
  if (
    input.repositoryUrl !== undefined &&
    (!requested || !names.includes(requested))
  )
    return {
      ok: false,
      status: 403,
      error: "Repository is outside the workspace read scope",
    }
  if (names.length === 0 || names.length > 500)
    return {
      ok: false,
      status: 403,
      error: "Workspace GitHub read scope must contain 1 to 500 repositories",
    }
  const token = await getWorkspaceGithubReadToken(claims.orgId, input.env, {
    githubConnectionId: connectionId,
    repoFullNames: names,
  })
  // GitHub IO occurs outside SQL. Do not disclose a credential after a relink,
  // deletion, completion, or loss of the native run owner during that request.
  if (JSON.stringify(await readScope()) !== JSON.stringify(names))
    return {
      ok: false,
      status: 403,
      error: "Workspace GitHub read scope changed",
    }
  if (!(await verifyWorkspaceChatRunCapability(authority)))
    return { ok: false, status: 401, error: "Unauthorized" }
  if (!token)
    return {
      ok: false,
      status: 503,
      error: "Workspace GitHub read credential unavailable",
    }
  return { ok: true, username: "x-access-token", password: token }
}
