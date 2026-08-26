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

export type CommitFile = {
  path: string
  content: string
  /** Defaults to utf-8. Use base64 for binary connector assets. */
  encoding?: "utf-8" | "base64"
}

const GITHUB_API_MAX_ATTEMPTS = 3

function githubErrorHeaders(
  error: unknown,
): Record<string, string | number | undefined> {
  if (
    !error ||
    typeof error !== "object" ||
    !("response" in error) ||
    !error.response ||
    typeof error.response !== "object" ||
    !("headers" in error.response) ||
    !error.response.headers ||
    typeof error.response.headers !== "object"
  ) {
    return {}
  }
  return error.response.headers as Record<string, string | number | undefined>
}

function isTransientGithubError(error: unknown): boolean {
  const st = (error as { status?: number }).status
  const headers = githubErrorHeaders(error)
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return (
    st === 429 ||
    (st === 403 &&
      (headers["retry-after"] !== undefined ||
        String(headers["x-ratelimit-remaining"]) === "0" ||
        message.includes("secondary rate limit") ||
        message.includes("abuse detection"))) ||
    (st === 422 && message.includes("not a fast forward")) ||
    (st !== undefined && st >= 500 && st < 600)
  )
}

function githubRetryDelayMs(error: unknown, attempt: number): number {
  const headers = githubErrorHeaders(error)
  const retryAfter = Number(headers["retry-after"])
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(15 * 60_000, retryAfter * 1000)
  }
  const resetAtSeconds = Number(headers["x-ratelimit-reset"])
  if (Number.isFinite(resetAtSeconds) && resetAtSeconds > 0) {
    return Math.min(
      15 * 60_000,
      Math.max(0, resetAtSeconds * 1000 - Date.now()),
    )
  }
  const status = (error as { status?: number }).status
  if (status === 403 || status === 429) return 60_000
  return 300 * 2 ** attempt
}

async function withTransientGitHubRetry<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let a = 0; a < GITHUB_API_MAX_ATTEMPTS; a += 1) {
    try {
      return await run()
    } catch (e) {
      last = e
      if (isTransientGithubError(e) && a < GITHUB_API_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, githubRetryDelayMs(e, a)))
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

export async function listFilesInTreeWithMetadata(
  input: BaseInput & { branch: string },
) {
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
    if (data.truncated) {
      const files: Array<{ path: string; sha: string }> = []
      const pendingTrees = [{ sha: head.treeSha, prefix: "" }]
      let treeIndex = 0
      while (treeIndex < pendingTrees.length) {
        const current = pendingTrees[treeIndex]
        treeIndex += 1
        if (!current) break
        const { data: subtree } = await context.octokit.rest.git.getTree({
          owner: context.owner,
          repo: context.repo,
          tree_sha: current.sha,
        })
        if (subtree.truncated) return { files, truncated: true }
        for (const entry of subtree.tree ?? []) {
          if (!entry.path) continue
          const path = current.prefix
            ? `${current.prefix}/${entry.path}`
            : entry.path
          if (entry.type === "blob") {
            files.push({ path, sha: entry.sha ?? "" })
          } else if (entry.type === "tree" && entry.sha) {
            pendingTrees.push({ sha: entry.sha, prefix: path })
          }
        }
        if (pendingTrees.length > 10_000) {
          return { files, truncated: true }
        }
      }
      return { files, truncated: false }
    }
    return {
      files: (data.tree ?? [])
        .filter((entry) => entry.type === "blob" && Boolean(entry.path))
        .map((entry) => ({ path: entry.path ?? "", sha: entry.sha ?? "" })),
      truncated: Boolean(data.truncated),
    }
  })
}

export async function listFilesInTree(input: BaseInput & { branch: string }) {
  const tree = await listFilesInTreeWithMetadata(input)
  if (tree.truncated) {
    throw new Error(
      "GitHub repository tree is truncated; refusing unsafe managed-file reconciliation",
    )
  }
  return tree.files
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
        await new Promise((r) => setTimeout(r, githubRetryDelayMs(error, a)))
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

export async function commitFiles(
  input: BaseInput & {
    branch: string
    message: string
    files: CommitFile[]
    deletePaths?: string[]
  },
) {
  const context = await getInstallationContext(input)
  let nextHead:
    | Awaited<ReturnType<typeof getOrInitializeBaseBranch>>
    | undefined = await withTransientGitHubRetry(() =>
    getOrInitializeBaseBranch({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      branch: input.branch,
    }),
  )
  const fileEntries: Array<{
    path: string
    mode: "100644"
    type: "blob"
    sha: string
  }> = []
  let lastBinaryBlobStartedAt = 0
  for (const file of input.files) {
    if (file.encoding === "base64" && lastBinaryBlobStartedAt > 0) {
      const remainingDelay = 1_000 - (Date.now() - lastBinaryBlobStartedAt)
      if (remainingDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingDelay))
      }
    }
    if (file.encoding === "base64") lastBinaryBlobStartedAt = Date.now()
    const blob = await withTransientGitHubRetry(() =>
      context.octokit.rest.git.createBlob({
        owner: context.owner,
        repo: context.repo,
        content: file.content,
        encoding: file.encoding ?? "utf-8",
      }),
    )
    fileEntries.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.data.sha,
    })
  }

  const deleteEntries = (input.deletePaths ?? []).map((path) => ({
    path,
    mode: "100644" as const,
    type: "blob" as const,
    sha: null,
  }))

  return withTransientGitHubRetry(async () => {
    const head =
      nextHead ??
      (await getOrInitializeBaseBranch({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        branch: input.branch,
      }))
    nextHead = undefined

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
  })
}

export async function createPullRequestWithFiles(
  input: BaseInput & {
    baseBranch: string
    title: string
    body: string
    commitMessage: string
    files: CommitFile[]
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

  const featureBranch = `${input.featureBranchPrefix ?? "ctxpipe/confluence-config"}-${Date.now()}`
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
    githubConnectionId: input.githubConnectionId,
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
