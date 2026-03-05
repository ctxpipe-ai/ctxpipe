import { eq } from "drizzle-orm"
import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "octokit"
import { readFileSync } from "node:fs"
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

export async function listReposForInstallation(
  installationId: string,
  env: Env,
): Promise<GitHubRepoItem[]> {
  const appId = env.GITHUB_APP_ID
  const privateKeyPath = env.GITHUB_PRIVATE_KEY_PATH
  if (!appId || !privateKeyPath) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY_PATH are required")
  }
  const privateKey = readFileSync(privateKeyPath, "utf-8")
  const auth = createAppAuth({
    appId,
    privateKey,
  })
  const installationAuth = await auth({
    type: "installation",
    installationId: Number.parseInt(installationId, 10),
  })
  const octokit = new Octokit({ auth: installationAuth.token })
  const repos: GitHubRepoItem[] = []
  let page = 1
  const perPage = 100
  while (true) {
    const accessibleRepos = await octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: perPage,
      page,
    })
    const {
      data: { repositories: batch },
    } = accessibleRepos
    if (!batch?.length) break
    for (const repo of batch) {
      repos.push({
        id: repo.id,
        full_name: repo.full_name ?? `${repo.owner?.login}/${repo.name}`,
        html_url: repo.html_url ?? "",
        clone_url: repo.clone_url ?? repo.ssh_url ?? "",
        name: repo.name ?? "",
      })
    }
    if (batch.length < perPage) break
    page += 1
  }
  return repos
}
