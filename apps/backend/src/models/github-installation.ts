import { and, eq, sql } from "drizzle-orm"
import { App, Octokit } from "octokit"
import type { Env } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { accounts, members, organizations } from "../db/schema/auth.js"
import {
  CONNECTION_TYPE_GITHUB,
  connections,
} from "../db/schema/connections.js"
import { generateObjectId } from "../lib/id.js"
import {
  githubConnectionToShape,
  githubShapeToConfig,
  type GitHubInstallationShape,
} from "./connection-rows.js"

/** @deprecated Alias for callers importing `GitHubInstallation`. */
export type GitHubInstallation = GitHubInstallationShape

export async function upsertInstallation(
  orgId: string,
  installationId: number,
): Promise<GitHubInstallationShape> {
  const db = getSystemDb()
  const [existing] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_GITHUB),
        sql`(${connections.config}->>'installationId')::int = ${installationId}`,
      ),
    )
    .limit(1)

  if (existing) {
    const [row] = await db
      .update(connections)
      .set({ updatedAt: new Date() })
      .where(eq(connections.id, existing.id))
      .returning()
    if (!row) throw new Error("Failed to upsert github installation")
    return githubConnectionToShape(row)
  }

  const id = generateObjectId("con")
  const config = githubShapeToConfig({
    installationId,
    ingestAllRepositories: false,
    includeFutureRepos: false,
  })
  const [row] = await db
    .insert(connections)
    .values({
      id,
      orgId,
      type: CONNECTION_TYPE_GITHUB,
      config,
    })
    .returning()
  if (!row) throw new Error("Failed to upsert github installation")
  return githubConnectionToShape(row)
}

/** First GitHub connection for org (ambiguous when multiple). */
export async function getInstallationByOrgId(
  orgId: string,
): Promise<GitHubInstallationShape | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(eq(connections.orgId, orgId), eq(connections.type, CONNECTION_TYPE_GITHUB)),
    )
    .limit(1)
  return row ? githubConnectionToShape(row) : undefined
}

export async function getGithubInstallationByConnectionId(
  orgId: string,
  connectionId: string,
): Promise<GitHubInstallationShape | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.orgId, orgId),
        eq(connections.type, CONNECTION_TYPE_GITHUB),
      ),
    )
    .limit(1)
  return row ? githubConnectionToShape(row) : undefined
}

/** Resolve org GitHub App installation row: explicit `connectionId` or first row. */
export async function resolveGithubInstallationForOrg(
  orgId: string,
  connectionId?: string | null,
): Promise<GitHubInstallationShape | undefined> {
  if (connectionId) {
    return getGithubInstallationByConnectionId(orgId, connectionId)
  }
  return getInstallationByOrgId(orgId)
}

export async function orgHasAnyGithubConnection(orgId: string): Promise<boolean> {
  const db = getSystemDb()
  const [row] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(eq(connections.orgId, orgId), eq(connections.type, CONNECTION_TYPE_GITHUB)),
    )
    .limit(1)
  return Boolean(row)
}

export async function listInstallationsByGithubInstallationId(
  githubInstallationId: number,
): Promise<GitHubInstallationShape[]> {
  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_GITHUB),
        sql`(${connections.config}->>'installationId')::int = ${githubInstallationId}`,
      ),
    )
  return rows.map(githubConnectionToShape)
}

export async function getOrganizationSlugForInstallationByUser(
  userId: string,
  installationId: number,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ orgSlug: organizations.slug })
    .from(connections)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, connections.orgId),
        eq(members.userId, userId),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, connections.orgId))
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_GITHUB),
        sql`(${connections.config}->>'installationId')::int = ${installationId}`,
      ),
    )
    .limit(1)
  return row?.orgSlug
}

export async function updateInstallationOptions(
  orgId: string,
  options: {
    ingestAllRepositories: boolean
    includeFutureRepos: boolean
  },
): Promise<GitHubInstallationShape | undefined> {
  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(eq(connections.orgId, orgId), eq(connections.type, CONNECTION_TYPE_GITHUB)),
    )
  const row = rows[0]
  if (!row) return undefined
  const shape = githubConnectionToShape(row)
  const config = githubShapeToConfig({
    installationId: shape.installationId,
    ...options,
  })
  const [updated] = await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
    .where(eq(connections.id, row.id))
    .returning()
  return updated ? githubConnectionToShape(updated) : undefined
}

export async function getGithubUserAccessToken(
  userId: string,
): Promise<string | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select({ accessToken: accounts.accessToken })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "github")))
    .limit(1)
  return row?.accessToken ?? undefined
}

export type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
}

let cachedApp: App | undefined

function getGitHubApp(env: Env): App {
  if (cachedApp) return cachedApp
  const appId = env.GITHUB_APP_ID
  const privateKeyRaw = env.GITHUB_PRIVATE_KEY?.trim()
  if (!appId || !privateKeyRaw) {
    const missing = [
      !appId ? "GITHUB_APP_ID" : null,
      !privateKeyRaw ? "GITHUB_PRIVATE_KEY" : null,
    ].filter((value): value is string => value != null)
    throw new Error(
      `GitHub App is not configured: missing ${missing.join(", ")}. OAuth credentials (GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET) are separate and only used for account linking.`,
    )
  }
  const privateKey = privateKeyRaw.includes("\\n")
    ? privateKeyRaw.replace(/\\n/g, "\n")
    : privateKeyRaw
  cachedApp = new App({ appId, privateKey })
  return cachedApp
}

export async function getInstallationOctokitForOrg(orgId: string, env: Env) {
  const installation = await getInstallationByOrgId(orgId)
  if (!installation) return undefined
  const app = getGitHubApp(env)
  const octokit = await app.getInstallationOctokit(installation.installationId)
  return {
    installation,
    octokit,
  }
}

export async function userCanAccessInstallation(
  accessToken: string,
  installationId: number,
): Promise<boolean> {
  const octokit = new Octokit({ auth: accessToken })

  const perPage = 100
  for (let page = 1; page <= 10; page += 1) {
    const { data } =
      await octokit.rest.apps.listInstallationsForAuthenticatedUser({
        per_page: perPage,
        page,
      })
    const installations = data.installations ?? []
    if (installations.some((i) => i.id === installationId)) return true
    if (installations.length < perPage) return false
  }

  return false
}

export async function getInstallationToken(
  orgId: string,
  env: Env,
): Promise<string | undefined> {
  const installation = await getInstallationByOrgId(orgId)
  if (!installation) return undefined
  const app = getGitHubApp(env)
  const octokit = await app.getInstallationOctokit(installation.installationId)
  const { token } = (await octokit.auth({ type: "installation" })) as {
    token: string
  }
  return token
}

function mapRepoItems(
  batch: Array<{
    id: number
    full_name: string
    owner?: { login?: string } | null
    name: string
    html_url?: string | null
    clone_url?: string | null
    ssh_url?: string | null
    default_branch?: string | null
  }>,
): GitHubRepoItem[] {
  return batch.map((repo) => ({
    id: repo.id,
    full_name: repo.full_name ?? `${repo.owner?.login}/${repo.name}`,
    html_url: repo.html_url ?? "",
    clone_url: repo.clone_url ?? repo.ssh_url ?? "",
    name: repo.name ?? "",
    default_branch: repo.default_branch ?? "main",
  }))
}

export async function listReposForInstallation(
  installationId: number,
  env: Env,
  page = 1,
  perPage = 30,
): Promise<{
  repositories: GitHubRepoItem[]
  repositorySelection: string
  hasMore: boolean
}> {
  const app = getGitHubApp(env)
  const octokit = await app.getInstallationOctokit(installationId)
  const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
    per_page: perPage,
    page,
  })
  const repositories = mapRepoItems(data.repositories ?? [])
  return {
    repositories,
    repositorySelection: data.repository_selection ?? "selected",
    hasMore: repositories.length === perPage,
  }
}

export async function searchReposForInstallation(
  installationId: number,
  env: Env,
  query: string,
  page = 1,
  perPage = 30,
): Promise<{
  repositories: GitHubRepoItem[]
  hasMore: boolean
  totalCount: number
}> {
  const app = getGitHubApp(env)
  const octokit = await app.getInstallationOctokit(installationId)

  const { data: installation } = await octokit.rest.apps.getInstallation({
    installation_id: installationId,
  })

  let searchQuery = query

  const account = installation.account
  if (account && "login" in account && account.login) {
    searchQuery = `${query} user:${account.login}`
  } else if (account && "slug" in account && account.slug) {
    searchQuery = `${query} org:${account.slug}`
  }

  const { data } = await octokit.rest.search.repos({
    q: searchQuery,
    per_page: perPage,
    page,
    sort: "updated",
    order: "desc",
  })

  const repositories = mapRepoItems(data.items ?? [])
  return {
    repositories,
    hasMore:
      data.items?.length === perPage && page * perPage < data.total_count,
    totalCount: data.total_count,
  }
}

export async function listAllReposForInstallation(
  installationId: number,
  env: Env,
): Promise<GitHubRepoItem[]> {
  const app = getGitHubApp(env)
  const octokit = await app.getInstallationOctokit(installationId)
  const repos: GitHubRepoItem[] = []
  let page = 1
  const perPage = 100
  while (true) {
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: perPage,
      page,
    })
    const batch = data.repositories
    if (!batch?.length) break
    repos.push(...mapRepoItems(batch))
    if (batch.length < perPage) break
    page += 1
  }
  return repos
}
