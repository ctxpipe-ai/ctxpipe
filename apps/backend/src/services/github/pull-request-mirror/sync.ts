import { createHash } from "node:crypto"
import type { Env } from "../../../config/env.js"
import { captureConnectorMirrorTarget } from "../../../domain/workspaces/capture-connector-mirror.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import type { GithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import {
  fetchGithubPullRequestSnapshot,
  listMergedPullRequestNumbers,
} from "./client.js"
import type { GithubPrMirrorRepoConfig } from "./config-yaml.js"
import { renderGithubPrConfigYaml } from "./config-yaml.js"
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

export async function prepareGithubPrMirrorConfigYaml(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  repositories: string[]
}) {
  const captured = await captureConnectorMirrorTarget({
    orgId: input.orgId,
    env: input.env,
    repositoryGitUrl: input.binding.gitUrl,
    mirror: {
      provider: "github",
      connectionId: input.binding.connectionId,
      repositoryId: input.binding.repositoryId,
    },
  })
  const yaml = renderGithubPrConfigYaml({
    repositories: input.repositories,
  })
  const files = [{ path: GITHUB_PR_CONFIG_PATH, content: yaml }]
  return {
    captured,
    files,
    jobId: `wjob_ghprcfg_${input.binding.connectionId}_${captured.revision.sha}_${createHash("sha1").update(yaml).digest("hex").slice(0, 12)}`,
  }
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

async function octokitForMirrorRepo(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  repository: string
}): Promise<Octokit> {
  const installation = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.binding.githubConnectionId,
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

export async function captureGithubPullRequest(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  config: GithubPrMirrorRepoConfig
  sourceRepository: string
  number: number
}): Promise<{ files: GithubPrMirrorFile[]; deletePaths: string[] }> {
  const file = await renderMirroredPullRequest({
    octokit: await octokitForMirrorRepo({
      orgId: input.orgId,
      env: input.env,
      binding: input.binding,
      repository: input.sourceRepository,
    }),
    config: input.config,
    repository: input.sourceRepository,
    number: input.number,
  })
  return {
    files: file ? [file] : [],
    deletePaths: [],
  }
}

/**
 * List merged pull request numbers for one `github/config.yaml` repository.
 * The content workflow snapshots this list in a durable step, then captures
 * and publishes {@link GITHUB_PR_MIRROR_COMMIT_BATCH}-sized batches.
 */
export async function listGithubPullRequestNumbersForConfig(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  config: GithubPrMirrorRepoConfig
  repository: string
}): Promise<{ numbers: number[] }> {
  const { owner, repo } = splitRepository(input.repository)
  return {
    numbers: await listMergedPullRequestNumbers({
      octokit: await octokitForMirrorRepo({
        orgId: input.orgId,
        env: input.env,
        binding: input.binding,
        repository: input.repository,
      }),
      owner,
      repo,
      max: input.config.maxPullRequestsPerRepository,
    }),
  }
}

/**
 * Render a bounded batch of mirrored pull requests for one repository.
 * Callers must pass at most {@link GITHUB_PR_MIRROR_COMMIT_BATCH} numbers.
 */
export async function captureGithubPullRequestsForConfig(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  config: GithubPrMirrorRepoConfig
  repository: string
  numbers: number[]
}): Promise<{ files: GithubPrMirrorFile[] }> {
  if (input.numbers.length > GITHUB_PR_MIRROR_COMMIT_BATCH) {
    throw new Error(
      `GitHub pull request capture cannot render more than ${GITHUB_PR_MIRROR_COMMIT_BATCH} pull requests`,
    )
  }
  const octokit = await octokitForMirrorRepo({
    orgId: input.orgId,
    env: input.env,
    binding: input.binding,
    repository: input.repository,
  })
  const files: GithubPrMirrorFile[] = []
  for (const number of input.numbers) {
    const file = await renderMirroredPullRequest({
      octokit,
      config: input.config,
      repository: input.repository,
      number,
    })
    if (file) files.push(file)
  }
  return { files }
}
