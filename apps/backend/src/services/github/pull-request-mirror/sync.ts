import type { Env } from "../../../config/env.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import {
  fetchMergedPullRequestPage,
  fetchPullRequestsByNumber,
  type GithubPrClient,
} from "./client.js"
import { renderGithubPullRequest } from "./converter.js"
import { shouldMirrorGithubPullRequest } from "./policy.js"
import type {
  GithubPrMirrorFile,
  GithubPrReview,
  GithubPullRequestSnapshot,
} from "./types.js"

/**
 * Backfill size per linked repository. ADR-028 caps one Git write at 250
 * files, so the whole backfill publishes as one commit.
 */
export const GITHUB_PR_BACKFILL_MAX = 200

/** Merged pull requests per GraphQL page; each page is one durable step. */
export const GITHUB_PR_PAGE_SIZE = 20

/**
 * GitHub's review decision: only each reviewer's latest APPROVED or
 * CHANGES_REQUESTED review counts; comments, dismissed and pending reviews
 * are ignored. Any outstanding change request wins over approvals.
 */
export function reviewDecisionFromReviews(
  reviews: ReadonlyArray<
    Pick<GithubPrReview, "author" | "state" | "submittedAt">
  >,
): "APPROVED" | "CHANGES_REQUESTED" | null {
  const latest = new Map<string, { state: string; submittedAt: string }>()
  for (const review of reviews) {
    const state = review.state.toUpperCase()
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue
    const submittedAt = review.submittedAt ?? ""
    const current = latest.get(review.author.login)
    if (!current || submittedAt >= current.submittedAt) {
      latest.set(review.author.login, { state, submittedAt })
    }
  }
  const states = [...latest.values()].map((entry) => entry.state)
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED"
  if (states.includes("APPROVED")) return "APPROVED"
  return null
}

type GithubPrSource = {
  orgId: string
  env: Env
  /** GitHub connection that reads `repository`. */
  connectionId: string
  /** `owner/repo`. */
  repository: string
}

async function clientFor(input: GithubPrSource) {
  const [owner, repo] = input.repository.split("/")
  if (!owner || !repo)
    throw new Error(`Invalid repository name "${input.repository}"`)
  const installation = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.connectionId,
    {
      repoFullName: input.repository,
      permissions: {
        contents: "read",
        metadata: "read",
        pull_requests: "read",
      },
    },
  )
  if (!installation) throw new Error("GitHub installation is not available")
  const octokit: GithubPrClient = installation.octokit
  return { octokit, owner, repo }
}

function render(snapshots: GithubPullRequestSnapshot[]): GithubPrMirrorFile[] {
  return snapshots.flatMap((snapshot) => {
    if (!shouldMirrorGithubPullRequest(snapshot)) return []
    snapshot.reviewDecision = reviewDecisionFromReviews(snapshot.reviews)
    return [renderGithubPullRequest(snapshot)]
  })
}

/** Render the named pull requests that the policy mirrors, in one provider request. */
export async function captureGithubPullRequests(
  input: GithubPrSource & { numbers: number[] },
): Promise<{ files: GithubPrMirrorFile[] }> {
  return {
    files: render(
      await fetchPullRequestsByNumber({
        ...(await clientFor(input)),
        numbers: input.numbers,
      }),
    ),
  }
}

/** Render one page of merged pull requests, newest update first. */
export async function captureMergedGithubPullRequestPage(
  input: GithubPrSource & { after: string | null },
): Promise<{
  files: GithubPrMirrorFile[]
  pulls: number
  nextAfter: string | null
}> {
  const page = await fetchMergedPullRequestPage({
    ...(await clientFor(input)),
    first: GITHUB_PR_PAGE_SIZE,
    after: input.after,
  })
  return {
    files: render(page.snapshots),
    pulls: page.snapshots.length,
    nextAfter: page.nextAfter,
  }
}
