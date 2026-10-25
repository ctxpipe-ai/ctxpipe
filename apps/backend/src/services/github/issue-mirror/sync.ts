import type { Env } from "../../../config/env.js"
import {
  getGithubAppInstallationPermissions,
  getInstallationOctokitForOrg,
} from "../../../models/github-installation.js"
import { getLogger } from "../../../observability/logger.js"
import type { GithubMirrorFile } from "../github-mirror.js"
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

/**
 * Why GitHub refused the issue credential (422): the installation has not
 * accepted the "Issues: Read-only" permission, or it does not cover the
 * repository.
 */
type IssuesSkipped = {
  skipped: "no_issues_permission" | "repository_not_covered"
}

/**
 * A GraphQL client with a credential that can read the issues of the
 * repository, or why GitHub refused it. The issue mirror then skips; the
 * pull request mirror is a separate workflow and is not affected.
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
    const permissions = await getGithubAppInstallationPermissions(
      input.orgId,
      input.env,
      input.connectionId,
    )
    const fields = {
      repository: input.repository,
      connectionId: input.connectionId,
    }
    if (permissions?.issues) {
      getLogger().warn("github_issue_mirror_repository_not_covered", {
        ...fields,
        cause:
          "The GitHub App installation does not have access to the repository",
        fix: "Add the repository to the repository access of the GitHub App installation",
      })
      return { skipped: "repository_not_covered" } as const
    }
    getLogger().warn("github_issue_mirror_no_permission", {
      ...fields,
      cause:
        "The owner of the GitHub App installation has not accepted the Issues permission",
      fix: "Accept the Issues permission on the GitHub App installation settings page",
    })
    return { skipped: "no_issues_permission" } as const
  }
}

/** Render one page of issues, most recently updated first. */
export async function captureGithubIssuePage(
  input: GithubIssueSource & { after: string | null },
): Promise<
  | { files: GithubMirrorFile[]; issues: number; nextAfter: string | null }
  | IssuesSkipped
> {
  const graphql = await graphqlFor(input)
  if (typeof graphql !== "function") return graphql
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
  { files: GithubMirrorFile[]; deletePaths: string[] } | IssuesSkipped
> {
  const graphql = await graphqlFor(input)
  if (typeof graphql !== "function") return graphql
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
