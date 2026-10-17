import type { Env } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
import { getInstallationOctokitForOrg } from "../../models/github-installation.js"
import { firstLineSubject, type ProjectedCommit } from "./commit-activity.js"
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
}): Promise<
  | { ok: true; commits: ProjectedCommit[] }
  /**
   * `unreachable`: the repository does not exist, or the app has no access
   * to it. `error`: any other failure.
   */
  | { ok: false; reason: "unreachable" | "error"; error?: unknown }
> {
  assertNotInOrgDbContext()
  const fullName = githubRepoFullNameFromWorkspaceUrl(
    input.workspaceRepositoryUrl,
  )
  if (!fullName) return { ok: true, commits: [] }
  const [owner, repo] = fullName.split("/")
  if (!owner || !repo) return { ok: true, commits: [] }

  try {
    const ctx = await getInstallationOctokitForOrg(
      input.orgId,
      input.env,
      input.githubConnectionId ?? undefined,
      {
        repoFullName: fullName,
        permissions: { contents: "read", metadata: "read" },
      },
    )
    if (!ctx) return { ok: false, reason: "unreachable" }

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
        const committedAt =
          item.commit.committer?.date ?? item.commit.author?.date
        if (!committedAt) continue
        collected.push({
          sha: item.sha,
          committedAt: new Date(committedAt),
          authorName:
            item.commit.author?.name?.trim() ||
            item.author?.login?.trim() ||
            "Unknown",
          // "": checked, no GitHub user (null is "not checked yet").
          authorLogin: item.author?.login?.trim() ?? "",
          subject: firstLineSubject(item.commit.message ?? ""),
          htmlUrl: item.html_url ?? null,
        })
      }
      if (hitKnown || data.length < PAGE_SIZE) break
    }
    return { ok: true, commits: collected }
  } catch (error) {
    return {
      ok: false,
      reason: unreachableStatus(error) ? "unreachable" : "error",
      error,
    }
  }
}

/**
 * GitHub answers 404 for a repository that does not exist or that the
 * installation cannot see, and 422 when it cannot make a token for such a
 * repository.
 */
function unreachableStatus(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined
  return status === 404 || status === 422
}
