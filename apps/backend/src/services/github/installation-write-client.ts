import type { Env } from "../../config/env.js"
import {
  getInstallationOctokitForOrg,
  type GitHubInstallation,
} from "../../models/github-installation.js"

type InstallationContext = NonNullable<
  Awaited<ReturnType<typeof getInstallationOctokitForOrg>>
>

type RepoCoordinates = {
  owner: string
  repo: string
}

type BaseInput = {
  orgId: string
  repositoryName: string
  env: Env
  /** When the org has multiple GitHub App connections, selects the installation token. */
  githubConnectionId?: string
}

type CommitFile = {
  path: string
  content: string
}

const GITHUB_API_MAX_ATTEMPTS = 3

function isTransientGithubError(error: unknown): boolean {
  const st = (error as { status?: number }).status
  return st === 429 || (st !== undefined && st >= 500 && st < 600)
}

async function withTransientGitHubRetry<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let a = 0; a < GITHUB_API_MAX_ATTEMPTS; a += 1) {
    try {
      return await run()
    } catch (e) {
      last = e
      if (isTransientGithubError(e) && a < GITHUB_API_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** a))
        continue
      }
      throw e
    }
  }
  throw last
}

function parseRepositoryName(repositoryName: string): RepoCoordinates {
  const [owner, repo] = repositoryName.split("/")
  if (!owner || !repo) {
    throw new Error(`Invalid repository name "${repositoryName}"`)
  }
  return { owner, repo }
}

async function getInstallationContext(input: BaseInput): Promise<{
  installation: GitHubInstallation
  octokit: InstallationContext["octokit"]
  owner: string
  repo: string
}> {
  const installationContext = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.githubConnectionId,
  )
  if (!installationContext) {
    throw new Error(`GitHub installation not found for org ${input.orgId}`)
  }
  const { owner, repo } = parseRepositoryName(input.repositoryName)
  return {
    installation: installationContext.installation,
    octokit: installationContext.octokit,
    owner,
    repo,
  }
}

async function getBranchHead(input: {
  octokit: InstallationContext["octokit"]
  owner: string
  repo: string
  branch: string
}) {
  const refName = `heads/${input.branch}`
  const { data } = await input.octokit.rest.git.getRef({
    owner: input.owner,
    repo: input.repo,
    ref: refName,
  })
  const commitSha = data.object.sha
  const { data: commit } = await input.octokit.rest.git.getCommit({
    owner: input.owner,
    repo: input.repo,
    commit_sha: commitSha,
  })
  return {
    commitSha,
    treeSha: commit.tree.sha,
  }
}

export async function listFilesInTree(input: BaseInput & { branch: string }) {
  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    const head = await getBranchHead({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      branch: input.branch,
    })
    const { data } = await context.octokit.rest.git.getTree({
      owner: context.owner,
      repo: context.repo,
      tree_sha: head.treeSha,
      recursive: "true",
    })
    return (data.tree ?? [])
      .filter((entry) => entry.type === "blob" && Boolean(entry.path))
      .map((entry) => ({ path: entry.path ?? "", sha: entry.sha ?? "" }))
  })
}

export async function getFileContent(
  input: BaseInput & { branch: string; path: string },
): Promise<string | undefined> {
  const context = await getInstallationContext(input)
  for (let a = 0; a < GITHUB_API_MAX_ATTEMPTS; a += 1) {
    let data: Awaited<
      ReturnType<typeof context.octokit.rest.repos.getContent>
    >["data"]
    try {
      const response = await context.octokit.rest.repos.getContent({
        owner: context.owner,
        repo: context.repo,
        path: input.path,
        ref: input.branch,
      })
      data = response.data
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 404) {
        return undefined
      }
      if (isTransientGithubError(error) && a < GITHUB_API_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** a))
        continue
      }
      throw error
    }
    if (Array.isArray(data) || !("content" in data)) {
      return undefined
    }
    if (!data.content) return ""
    return Buffer.from(data.content, "base64").toString("utf8")
  }
  return undefined
}

export async function commitFiles(input: BaseInput & {
  branch: string
  message: string
  files: CommitFile[]
  deletePaths?: string[]
}) {
  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    const head = await getBranchHead({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      branch: input.branch,
    })

    const fileEntries = await Promise.all(
      input.files.map(async (file) => {
        const blob = await context.octokit.rest.git.createBlob({
          owner: context.owner,
          repo: context.repo,
          content: file.content,
          encoding: "utf-8",
        })
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.data.sha,
        }
      }),
    )

    const deleteEntries = (input.deletePaths ?? []).map((path) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: null,
    }))

    const { data: tree } = await context.octokit.rest.git.createTree({
      owner: context.owner,
      repo: context.repo,
      base_tree: head.treeSha,
      tree: [...fileEntries, ...deleteEntries],
    })

    const { data: commit } = await context.octokit.rest.git.createCommit({
      owner: context.owner,
      repo: context.repo,
      message: input.message,
      tree: tree.sha,
      parents: [head.commitSha],
    })

    await context.octokit.rest.git.updateRef({
      owner: context.owner,
      repo: context.repo,
      ref: `heads/${input.branch}`,
      sha: commit.sha,
    })

    return {
      commitSha: commit.sha,
      branch: input.branch,
      installationId: context.installation.installationId,
    }
  })
}

export async function createPullRequestWithFiles(input: BaseInput & {
  baseBranch: string
  title: string
  body: string
  commitMessage: string
  files: CommitFile[]
}) {
  const context = await getInstallationContext(input)
  const base = await getBranchHead({
    octokit: context.octokit,
    owner: context.owner,
    repo: context.repo,
    branch: input.baseBranch,
  })

  const featureBranch = `ctxpipe/confluence-config-${Date.now()}`
  await withTransientGitHubRetry(() =>
    context.octokit.rest.git.createRef({
      owner: context.owner,
      repo: context.repo,
      ref: `refs/heads/${featureBranch}`,
      sha: base.commitSha,
    }),
  )

  await commitFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    branch: featureBranch,
    message: input.commitMessage,
    files: input.files,
  })

  const { data: pull } = await withTransientGitHubRetry(() =>
    context.octokit.rest.pulls.create({
      owner: context.owner,
      repo: context.repo,
      head: featureBranch,
      base: input.baseBranch,
      title: input.title,
      body: input.body,
    }),
  )

  return {
    pullNumber: pull.number,
    pullUrl: pull.html_url,
    branch: featureBranch,
  }
}
