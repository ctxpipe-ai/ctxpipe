import type { Env } from "../../../config/env.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import type { GithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import { log } from "../../../observability/logger.js"
import { type CommitFile, commitFiles } from "../installation-write-client.js"
import type { GithubPrMirrorRepoConfig } from "../pull-request-mirror/config-yaml.js"
import {
  fetchGithubIssue,
  fetchGithubIssues,
  type GithubGraphql,
} from "./client.js"
import { renderGithubIssue } from "./converter.js"

/** One durable step: `step.run({ name }, run)` in a workflow. */
export type RunStep = <T>(name: string, run: () => Promise<T>) => Promise<T>

async function installationGraphql(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
}): Promise<GithubGraphql> {
  const installation = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.binding.githubConnectionId,
  )
  if (!installation) throw new Error("GitHub installation is not available")
  return installation.octokit.graphql
}

/**
 * The App cannot read this repository's issues: every error is `FORBIDDEN`
 * (no Issues: Read) or `NOT_FOUND` (no repository access) on the repository
 * or its issue list. Anything else, or a missing single issue, is retryable.
 */
function isUnreadable(error: unknown): boolean {
  const { errors } = (error ?? {}) as {
    errors?: Array<{ type?: string; path?: unknown[] }>
  }
  return (
    errors !== undefined &&
    errors.length > 0 &&
    errors.every(
      (entry) =>
        (entry.type === "FORBIDDEN" || entry.type === "NOT_FOUND") &&
        ["repository", "repository.issues"].includes(
          entry.path?.join(".") ?? "",
        ),
    )
  )
}

/**
 * One durable step per repository (`issues-<repo>`): read, render, commit.
 * The per-repository cap bounds a step to a few requests and one repository's
 * files in memory; a step per page would reach OpenWorkflow's 1,000-step run
 * limit at about 250 repositories. A repository the App cannot read is
 * skipped and reported, so pull-request capture still completes; any other
 * error fails the run so the next sync retries it.
 */
export async function mirrorGithubIssues(input: {
  graphql: GithubGraphql
  repositories: string[]
  maxIssuesPerRepository: number
  runStep: RunStep
  commit: (repository: string, files: CommitFile[]) => Promise<unknown>
}): Promise<{ written: number; failedRepositories: string[] }> {
  let written = 0
  const failedRepositories: string[] = []
  for (const repository of input.repositories) {
    const result = await input.runStep(`issues-${repository}`, async () => {
      try {
        const files = (
          await fetchGithubIssues({
            graphql: input.graphql,
            repository,
            max: input.maxIssuesPerRepository,
          })
        ).map(renderGithubIssue)
        if (files.length > 0) await input.commit(repository, files)
        return { written: files.length }
      } catch (error) {
        if (!isUnreadable(error)) throw error
        // No workflow logger here: githubSyncContent sets one only for ingestion.
        log.warn({
          step: "github.issue-mirror.repository",
          message: "GitHub App cannot read this repository's issues; skipped",
          repository,
          error: error instanceof Error ? error.message : String(error),
        })
        return { unreadable: true as const }
      }
    })
    if ("unreadable" in result) failedRepositories.push(repository)
    else written += result.written
  }
  return { written, failedRepositories }
}

/** Backfill the issues of every `github/config.yaml` repository. */
export async function mirrorGithubIssuesForConfig(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  config: GithubPrMirrorRepoConfig
  runStep: RunStep
}): Promise<{ written: number; failedRepositories: string[] }> {
  if (!input.config.issues || input.config.repositories.length === 0) {
    return { written: 0, failedRepositories: [] }
  }
  return mirrorGithubIssues({
    graphql: await installationGraphql(input),
    repositories: input.config.repositories,
    maxIssuesPerRepository: input.config.issues.maxIssuesPerRepository,
    runStep: input.runStep,
    commit: (repository, files) =>
      commitFiles({
        orgId: input.orgId,
        env: input.env,
        repositoryName: input.binding.repositoryName,
        githubConnectionId: input.binding.githubConnectionId,
        branch: input.binding.branch,
        message: `Mirror GitHub issues ${repository} (${files.length} files)`,
        files,
      }),
  })
}

export async function syncGithubIssueToGit(input: {
  orgId: string
  env: Env
  binding: GithubPrMirrorBinding
  sourceRepository: string
  number: number
}): Promise<{ written: boolean; path: string }> {
  const file = renderGithubIssue(
    await fetchGithubIssue({
      graphql: await installationGraphql(input),
      repository: input.sourceRepository,
      number: input.number,
    }),
  )
  await commitFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.binding.repositoryName,
    githubConnectionId: input.binding.githubConnectionId,
    branch: input.binding.branch,
    message: `Mirror GitHub issue ${input.sourceRepository}#${input.number}`,
    files: [file],
  })
  return { written: true, path: file.path }
}
