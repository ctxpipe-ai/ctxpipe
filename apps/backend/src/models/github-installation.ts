import { eq } from "drizzle-orm"
import { App } from "octokit"
import type { Env } from "../config/env.js"
import { generateObjectId } from "../lib/id.js"
import { getSystemDb } from "../db/client.js"
import { githubInstallations } from "../db/schema/github.js"

export type GitHubInstallation = typeof githubInstallations.$inferSelect

export async function upsertInstallation(
  orgId: string,
  installationId: number,
): Promise<GitHubInstallation> {
  const db = getSystemDb()
  const id = generateObjectId("ghi")
  const [row] = await db
    .insert(githubInstallations)
    .values({
      id,
      installationId,
      orgId,
    })
    .onConflictDoUpdate({
      target: [
        githubInstallations.orgId,
        githubInstallations.installationId,
      ],
      set: {
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error("Failed to upsert github installation")
  return row
}

export async function getInstallationByOrgId(
  orgId: string,
): Promise<GitHubInstallation | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId))
    .limit(1)
  return row
}

export async function updateInstallationOptions(
  orgId: string,
  options: {
    ingestAllRepositories: boolean
    includeFutureRepos: boolean
  },
): Promise<GitHubInstallation | undefined> {
  const db = getSystemDb()
  const [row] = await db
    .update(githubInstallations)
    .set({
      ...options,
      updatedAt: new Date(),
    })
    .where(eq(githubInstallations.orgId, orgId))
    .returning()
  return row
}

export type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
}

let cachedApp: App | undefined

function getGitHubApp(env: Env): App {
  if (cachedApp) return cachedApp
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_PRIVATE_KEY
  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required")
  }
  cachedApp = new App({ appId, privateKey })
  return cachedApp
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
  }>,
): GitHubRepoItem[] {
  return batch.map((repo) => ({
    id: repo.id,
    full_name: repo.full_name ?? `${repo.owner?.login}/${repo.name}`,
    html_url: repo.html_url ?? "",
    clone_url: repo.clone_url ?? repo.ssh_url ?? "",
    name: repo.name ?? "",
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
  const { data } =
    await octokit.rest.apps.listReposAccessibleToInstallation({
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
    const { data } =
      await octokit.rest.apps.listReposAccessibleToInstallation({
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
