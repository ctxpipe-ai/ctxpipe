import type { Env } from "../../../config/env.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import type { GithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import { log } from "../../../observability/logger.js"
import {
  commitFiles,
  createPullRequestWithFiles,
} from "../installation-write-client.js"
import {
  fetchGithubPullRequestSnapshot,
  listMergedPullRequestNumbers,
} from "./client.js"
import type { GithubPrMirrorRepoConfig } from "./config-yaml.js"
import {
  getGithubPrConfigPullRequestPayload,
  renderGithubPrConfigYaml,
} from "./config-yaml.js"
import { GITHUB_PR_CONFIG_PATH, renderGithubPullRequest } from "./converter.js"
import { shouldMirrorGithubPullRequest } from "./policy.js"
import type { GithubPrMirrorFile, GithubPrReview } from "./types.js"

/** ADR-028 caps one Git write at 250 files; batch backfills below that. */
export const GITHUB_PR_MIRROR_COMMIT_BATCH = 200

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

export async function syncGithubPrMirrorConfigYaml(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  repositories: string[]
}): Promise<{ pullUrl: string; pullNumber: number }> {
  const payload = getGithubPrConfigPullRequestPayload({
    repositoryCount: input.repositories.length,
  })
  return createPullRequestWithFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.binding.repositoryName,
    githubConnectionId: input.binding.githubConnectionId,
    baseBranch: input.binding.branch,
    title: payload.title,
    body: payload.body,
    commitMessage: "Add github/config.yaml for pull request mirroring",
    files: [
      {
        path: GITHUB_PR_CONFIG_PATH,
        content: renderGithubPrConfigYaml({
          repositories: input.repositories,
        }),
      },
    ],
    featureBranchPrefix: "ctxpipe/github-pr-config",
  })
}

/** Fetch, decide, render. Null when the scope policy excludes the pull request. */
async function renderMirroredPullRequest(input: {
  octokit: Octokit
  config: GithubPrMirrorRepoConfig
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
  if (
    !shouldMirrorGithubPullRequest({
      config: input.config,
      candidate: {
        repository: snapshot.repository,
        merged: snapshot.merged,
        draft: snapshot.draft,
        updatedAt: snapshot.updatedAt,
      },
    })
  ) {
    return null
  }
  return renderGithubPullRequest(snapshot)
}

export async function syncGithubPullRequestToGit(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  config: GithubPrMirrorRepoConfig
  sourceRepository: string
  number: number
}): Promise<{ written: boolean; path?: string }> {
  const installation = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.binding.githubConnectionId,
  )
  if (!installation) {
    throw new Error("GitHub installation is not available")
  }
  const file = await renderMirroredPullRequest({
    octokit: installation.octokit,
    config: input.config,
    repository: input.sourceRepository,
    number: input.number,
  })
  if (!file) return { written: false }
  await commitFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.binding.repositoryName,
    githubConnectionId: input.binding.githubConnectionId,
    branch: input.binding.branch,
    message: `Mirror GitHub pull request ${input.sourceRepository}#${input.number}`,
    files: [file],
  })
  return { written: true, path: file.path }
}

/**
 * Backfill every repository in `github/config.yaml`. Files are rendered first
 * and committed in batches (one push webhook per batch, not per pull request).
 * A repository that fails is skipped and reported; the whole backfill fails
 * only when every repository failed.
 */
export async function syncGithubPullRequestsForConfig(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  config: GithubPrMirrorRepoConfig
}): Promise<{ written: number; failedRepositories: string[] }> {
  const installation = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.binding.githubConnectionId,
  )
  if (!installation) {
    throw new Error("GitHub installation is not available")
  }
  let written = 0
  const failedRepositories: string[] = []
  for (const repository of input.config.repositories) {
    try {
      const { owner, repo } = splitRepository(repository)
      const numbers = await listMergedPullRequestNumbers({
        octokit: installation.octokit,
        owner,
        repo,
        max: input.config.maxPullRequestsPerRepository,
      })
      const files: GithubPrMirrorFile[] = []
      for (const number of numbers) {
        const file = await renderMirroredPullRequest({
          octokit: installation.octokit,
          config: input.config,
          repository,
          number,
        })
        if (file) files.push(file)
      }
      for (let i = 0; i < files.length; i += GITHUB_PR_MIRROR_COMMIT_BATCH) {
        const batch = files.slice(i, i + GITHUB_PR_MIRROR_COMMIT_BATCH)
        await commitFiles({
          orgId: input.orgId,
          env: input.env,
          repositoryName: input.binding.repositoryName,
          githubConnectionId: input.binding.githubConnectionId,
          branch: input.binding.branch,
          message: `Mirror GitHub pull requests ${repository} (${batch.length} files)`,
          files: batch,
        })
        written += batch.length
      }
    } catch (error) {
      failedRepositories.push(repository)
      const normalized =
        error instanceof Error ? error : new Error(String(error))
      log.error({
        message: "github pr mirror: repository backfill failed",
        orgId: input.orgId,
        repository,
        error: normalized.message,
      })
    }
  }
  if (
    failedRepositories.length > 0 &&
    failedRepositories.length === input.config.repositories.length
  ) {
    throw new Error(
      `GitHub pull request backfill failed for every repository: ${failedRepositories.join(", ")}`,
    )
  }
  return { written, failedRepositories }
}
