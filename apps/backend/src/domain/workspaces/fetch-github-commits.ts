import { assertNotInOrgDbContext } from "../../db/client.js"
import { getInstallationOctokitForOrg } from "../../models/github-installation.js"
import type { Env } from "../../config/env.js"
import {
  firstLineSubject,
  type ProjectedCommit,
} from "./commit-activity.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

const PAGE_SIZE = 100
const MAX_PAGES = 20

export async function fetchGithubWorkspaceCommits(input: {
  orgId: string
  githubConnectionId?: string | null
  workspaceRepositoryUrl: string
  since: Date
  existingShas: ReadonlySet<string>
  env: Env
}): Promise<{ commits: ProjectedCommit[]; ok: boolean }> {
  assertNotInOrgDbContext()
  const fullName = githubRepoFullNameFromWorkspaceUrl(
    input.workspaceRepositoryUrl,
  )
  if (!fullName) return { commits: [], ok: true }
  const [owner, repo] = fullName.split("/")
  if (!owner || !repo) return { commits: [], ok: true }

  try {
    const ctx = await getInstallationOctokitForOrg(
      input.orgId,
      input.env,
      input.githubConnectionId ?? undefined,
    )
    if (!ctx) return { commits: [], ok: false }

    const collected: ProjectedCommit[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await ctx.octokit.rest.repos.listCommits({
        owner,
        repo,
        since: input.since.toISOString(),
        per_page: PAGE_SIZE,
        page,
      })
      if (data.length === 0) break
      let hitKnown = false
      for (const item of data) {
        if (input.existingShas.has(item.sha)) {
          hitKnown = true
          continue
        }
        const committedAt = item.commit.committer?.date ?? item.commit.author?.date
        if (!committedAt) continue
        collected.push({
          sha: item.sha,
          committedAt: new Date(committedAt),
          authorName:
            item.commit.author?.name?.trim() ||
            item.author?.login?.trim() ||
            "Unknown",
          subject: firstLineSubject(item.commit.message ?? ""),
          htmlUrl: item.html_url ?? null,
        })
      }
      if (hitKnown || data.length < PAGE_SIZE) break
    }
    return { commits: collected, ok: true }
  } catch {
    return { commits: [], ok: false }
  }
}
