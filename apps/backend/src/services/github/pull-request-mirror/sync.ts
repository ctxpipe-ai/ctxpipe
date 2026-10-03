import type { Env } from "../../../config/env.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import {
  fetchGithubPullRequestSnapshot,
  listMergedPullRequestNumbers,
} from "./client.js"
import { renderGithubPullRequest } from "./converter.js"
import { shouldMirrorGithubPullRequest } from "./policy.js"
import type { GithubPrMirrorFile, GithubPrReview } from "./types.js"

/**
 * Backfill size per linked repository. ADR-028 caps one Git write at 250
 * files, so the whole backfill publishes as one commit.
 */
export const GITHUB_PR_BACKFILL_MAX = 200

type Octokit =
  Awaited<ReturnType<typeof getInstallationOctokitForOrg>> extends infer T
    ? T extends { octokit: infer O }
      ? O
      : never
    : never

function splitRepository(name: string): { owner: string; repo: string } {
  const [owner, repo] = name.split("/")
  if (!owner || !repo) throw new Error(`Invalid repository name "${name}"`)
  return { owner, repo }
}

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

async function octokitFor(input: GithubPrSource): Promise<Octokit> {
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
  if (!installation) {
    throw new Error("GitHub installation is not available")
  }
  return installation.octokit
}

/** Fetch, decide, render. Null when the policy excludes the pull request. */
async function renderMirroredPullRequest(input: {
  octokit: Octokit
  repository: string
  number: number
}): Promise<GithubPrMirrorFile | null> {
  const { owner, repo } = splitRepository(input.repository)
  const snapshot = await fetchGithubPullRequestSnapshot({
    octokit: input.octokit,
    owner,
    repo,
    number: input.number,
  })
  snapshot.reviewDecision = reviewDecisionFromReviews(snapshot.reviews)
  if (!shouldMirrorGithubPullRequest(snapshot)) return null
  return renderGithubPullRequest(snapshot)
}

/** Render the mirrored pull requests among `numbers`; excluded ones are skipped. */
export async function captureGithubPullRequests(
  input: GithubPrSource & { numbers: number[] },
): Promise<{ files: GithubPrMirrorFile[] }> {
  const octokit = await octokitFor(input)
  const files: GithubPrMirrorFile[] = []
  for (const number of input.numbers) {
    const file = await renderMirroredPullRequest({
      octokit,
      repository: input.repository,
      number,
    })
    if (file) files.push(file)
  }
  return { files }
}

/** The {@link GITHUB_PR_BACKFILL_MAX} most recently updated merged pull requests. */
export async function listGithubPullRequestsToBackfill(
  input: GithubPrSource,
): Promise<{ numbers: number[] }> {
  const { owner, repo } = splitRepository(input.repository)
  return {
    numbers: await listMergedPullRequestNumbers({
      octokit: await octokitFor(input),
      owner,
      repo,
      max: GITHUB_PR_BACKFILL_MAX,
    }),
  }
}
