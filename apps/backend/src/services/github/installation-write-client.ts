import type { Env } from "../../config/env.js"
import {
  type GitHubInstallation,
  getInstallationOctokitForOrg,
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
  /** Defaults to utf-8. Use base64 for binary connector assets. */
  encoding?: "utf-8" | "base64"
}

const GITHUB_API_MAX_ATTEMPTS = 3

function isTransientGithubError(error: unknown): boolean {
  const st = (error as { status?: number }).status
  return (
    st === 429 ||
    (st === 422 &&
      error instanceof Error &&
      error.message.toLowerCase().includes("not a fast forward")) ||
    (st !== undefined && st >= 500 && st < 600)
  )
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

function isEmptyGithubRepositoryError(error: unknown): boolean {
  return (
    (error as { status?: number }).status === 409 &&
    error instanceof Error &&
    error.message.includes("Git Repository is empty")
  )
}

async function getOrInitializeBaseBranch(input: {
  octokit: InstallationContext["octokit"]
  owner: string
  repo: string
  branch: string
}) {
  try {
    return await getBranchHead(input)
  } catch (error) {
    if (!isEmptyGithubRepositoryError(error)) throw error
  }

  try {
    await withTransientGitHubRetry(() =>
      input.octokit.rest.repos.createOrUpdateFileContents({
        owner: input.owner,
        repo: input.repo,
        path: ".gitkeep",
        message: "Initialize repository for ctxpipe",
        content: Buffer.from("\n").toString("base64"),
      }),
    )
  } catch (error) {
    // Another config workflow may have initialized the repository concurrently.
    try {
      return await getBranchHead(input)
    } catch {
      throw error
    }
  }

  return getBranchHead(input)
}

export async function listFilesInTree(input: BaseInput & { branch: string }) {
  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    const head = await getOrInitializeBaseBranch({
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

export async function getCommitTimestamp(
  input: BaseInput & { sha: string },
): Promise<string | null> {
  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    const { data } = await context.octokit.rest.git.getCommit({
      owner: context.owner,
      repo: context.repo,
      commit_sha: input.sha,
    })
    const raw = data.committer?.date ?? data.author?.date
    if (!raw) return null
    const parsed = new Date(raw)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  })
}
export async function listFilesAtSha(input: BaseInput & { sha: string }) {
  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    try {
      const { data } = await context.octokit.rest.git.getTree({
        owner: context.owner,
        repo: context.repo,
        tree_sha: input.sha,
        recursive: "true",
      })
      return (data.tree ?? [])
        .filter((entry) => entry.type === "blob" && Boolean(entry.path))
        .map((entry) => ({ path: entry.path ?? "", sha: entry.sha ?? "" }))
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 404 || status === 409) return []
      throw error
    }
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

export async function githubRefExists(
  input: BaseInput & { ref: string },
): Promise<boolean> {
  try {
    const context = await getInstallationContext(input)
    const ref = input.ref.replace(/^refs\//, "")
    const refName = ref.startsWith("heads/") ? ref : `heads/${ref}`
    await context.octokit.rest.git.getRef({
      owner: context.owner,
      repo: context.repo,
      ref: refName,
    })
    return true
  } catch (error) {
    if ((error as { status?: number }).status === 404) return false
    throw error
  }
}

export async function commitFiles(
  input: BaseInput & {
    branch: string
    message: string
    files: CommitFile[]
    deletePaths?: string[]
    /** When set, commit against this parent and refuse overlay-on-latest-head. */
    expectedParentSha?: string
  },
) {
  const commitOnce = async (head: { commitSha: string; treeSha: string }) => {
    const context = await getInstallationContext(input)
    const fileEntries = await Promise.all(
      input.files.map(async (file) => {
        const blob = await context.octokit.rest.git.createBlob({
          owner: context.owner,
          repo: context.repo,
          content: file.content,
          encoding: file.encoding ?? "utf-8",
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
      installationId: context.installation.installationId ?? 0,
    }
  }

  if (input.expectedParentSha) {
    const context = await getInstallationContext(input)
    const { data: commit } = await context.octokit.rest.git.getCommit({
      owner: context.owner,
      repo: context.repo,
      commit_sha: input.expectedParentSha,
    })
    return commitOnce({
      commitSha: input.expectedParentSha,
      treeSha: commit.tree.sha,
    })
  }

  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    const head = await getOrInitializeBaseBranch({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      branch: input.branch,
    })
    return commitOnce(head)
  })
}

export async function createPullRequestWithFiles(
  input: BaseInput & {
    baseBranch: string
    title: string
    body: string
    commitMessage: string
    files: CommitFile[]
    deletePaths?: string[]
    /** Exact session branch. When omitted, uses featureBranchPrefix + timestamp. */
    branch?: string
    /** When true, a 422 on createRef is a collision — do not overlay an existing branch. */
    requireNewBranch?: boolean
    /** Defaults to the historical Confluence prefix. */
    featureBranchPrefix?: string
  },
) {
  const context = await getInstallationContext(input)
  const base = await getOrInitializeBaseBranch({
    octokit: context.octokit,
    owner: context.owner,
    repo: context.repo,
    branch: input.baseBranch,
  })

  const featureBranch =
    input.branch ??
    `${input.featureBranchPrefix ?? "ctxpipe/confluence-config"}-${Date.now()}`
  try {
    await withTransientGitHubRetry(() =>
      context.octokit.rest.git.createRef({
        owner: context.owner,
        repo: context.repo,
        ref: `refs/heads/${featureBranch}`,
        sha: base.commitSha,
      }),
    )
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number(error.status)
        : 0
    if (status !== 422 || input.requireNewBranch) throw error
  }

  await commitFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: featureBranch,
    message: input.commitMessage,
    files: input.files,
    deletePaths: input.deletePaths,
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

/** Parses `html_url`-style GitHub PR URLs into pull number (best-effort). */
export function parseGithubPullNumberFromUrl(url: string): number | undefined {
  const m = url.match(/\/pull\/(\d+)/)
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined
}

/** Resolve the head branch (ref) of an open pull request from its URL. */
export async function getPullRequestHeadBranch(
  input: BaseInput & { pullUrl: string },
): Promise<string | undefined> {
  const pullNumber = parseGithubPullNumberFromUrl(input.pullUrl)
  if (pullNumber === undefined) return undefined
  const context = await getInstallationContext(input)
  const { data } = await withTransientGitHubRetry(() =>
    context.octokit.rest.pulls.get({
      owner: context.owner,
      repo: context.repo,
      pull_number: pullNumber,
    }),
  )
  return data.head.ref || undefined
}

/** Whether `compareCommits` lists `path` among added/changed/removed files (push webhook fallback). */
export async function compareCommitsTouchesPath(
  input: BaseInput & {
    baseSha: string
    headSha: string
    path: string
  },
): Promise<boolean> {
  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    const { data } = await context.octokit.rest.repos.compareCommits({
      owner: context.owner,
      repo: context.repo,
      base: input.baseSha,
      head: input.headSha,
    })
    const want = input.path
    for (const f of data.files ?? []) {
      if (f.filename === want || f.previous_filename === want) return true
    }
    return false
  })
}

export async function closePullRequest(
  input: BaseInput & {
    pullNumber: number
    comment?: string
  },
) {
  const context = await getInstallationContext(input)
  await withTransientGitHubRetry(() =>
    context.octokit.rest.pulls.update({
      owner: context.owner,
      repo: context.repo,
      pull_number: input.pullNumber,
      state: "closed",
    }),
  )
  if (input.comment) {
    const body = input.comment
    await withTransientGitHubRetry(() =>
      context.octokit.rest.issues.createComment({
        owner: context.owner,
        repo: context.repo,
        issue_number: input.pullNumber,
        body,
      }),
    )
  }
}
