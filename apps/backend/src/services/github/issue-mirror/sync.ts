import type { Env } from "../../../config/env.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import { getLogger } from "../../../observability/logger.js"
import type { GithubPrMirrorFile } from "../pull-request-mirror/types.js"
import { fetchGithubIssue, fetchGithubIssuePage } from "./client.js"
import { githubIssueMarkdownPath, renderGithubIssue } from "./converter.js"

/**
 * Backfill size per linked repository. ADR-028 caps one Git write at 250
 * files, so the whole backfill publishes as one commit.
 */
export const GITHUB_ISSUE_BACKFILL_MAX = 200

/** Issues per GraphQL page; each page is one durable step. */
const GITHUB_ISSUE_PAGE_SIZE = 50

type GithubIssueSource = {
  orgId: string
  env: Env
  /** GitHub connection that reads `repository`. */
  connectionId: string
  /** `owner/repo`. */
  repository: string
}

/** The installation has not accepted the "Issues: Read-only" permission. */
type NoIssuesPermission = { skipped: "no_issues_permission" }

/**
 * A GraphQL client with a credential that can read the issues of the
 * repository. GitHub refuses the credential (422) when the owner of the
 * installation has not accepted the Issues permission yet; the mirror then
 * skips, and the pull request mirror is not affected.
 */
async function graphqlFor(input: GithubIssueSource) {
  try {
    const installation = await getInstallationOctokitForOrg(
      input.orgId,
      input.env,
      input.connectionId,
      {
        repoFullName: input.repository,
        permissions: { issues: "read", metadata: "read" },
      },
    )
    if (!installation) throw new Error("GitHub installation is not available")
    return installation.octokit.graphql
  } catch (error) {
    if ((error as { status?: number } | null)?.status !== 422) throw error
    getLogger().warn("github_issue_mirror_no_permission", {
      repository: input.repository,
      connectionId: input.connectionId,
      fix: "Accept the Issues permission on the GitHub App installation",
    })
    return null
  }
}

/** Render one page of issues, most recently updated first. */
export async function captureGithubIssuePage(
  input: GithubIssueSource & { after: string | null },
): Promise<
  | { files: GithubPrMirrorFile[]; issues: number; nextAfter: string | null }
  | NoIssuesPermission
> {
  const graphql = await graphqlFor(input)
  if (!graphql) return { skipped: "no_issues_permission" }
  const page = await fetchGithubIssuePage({
    graphql,
    repository: input.repository,
    first: GITHUB_ISSUE_PAGE_SIZE,
    after: input.after,
  })
  return {
    files: page.issues.map(renderGithubIssue),
    issues: page.issues.length,
    nextAfter: page.nextAfter,
  }
}

/**
 * Render one issue. An issue that GitHub no longer has (deleted or moved
 * to another repository) gives its path to delete.
 */
export async function captureGithubIssue(
  input: GithubIssueSource & { number: number },
): Promise<
  { files: GithubPrMirrorFile[]; deletePaths: string[] } | NoIssuesPermission
> {
  const graphql = await graphqlFor(input)
  if (!graphql) return { skipped: "no_issues_permission" }
  const issue = await fetchGithubIssue({
    graphql,
    repository: input.repository,
    number: input.number,
  })
  return issue
    ? { files: [renderGithubIssue(issue)], deletePaths: [] }
    : {
        files: [],
        deletePaths: [githubIssueMarkdownPath(input.repository, input.number)],
      }
}
