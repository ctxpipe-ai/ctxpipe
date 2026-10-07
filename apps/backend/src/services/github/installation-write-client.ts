import type { Env } from "../../config/env.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "../../domain/workspaces/revision.js"
import {
  type GitHubInstallation,
  getInstallationOctokitForOrg,
} from "../../models/github-installation.js"
import { getDesiredWorkspaceRevision } from "../../models/workspaces.js"

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
    return Math.max(0, resetAtSeconds * 1000 - Date.now())
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

async function getInstallationContext(
  input: BaseInput,
  permissions: {
    contents?: "read" | "write"
    pull_requests?: "read" | "write"
  } = { contents: "read" },
): Promise<{
  installation: GitHubInstallation
  octokit: InstallationContext["octokit"]
  owner: string
  repo: string
}> {
  const installationContext = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.githubConnectionId,
    {
      repoFullName: input.repositoryName,
      permissions: { ...permissions, metadata: "read" },
    },
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

async function assertConfigBranch(
  context: Awaited<ReturnType<typeof getInstallationContext>>,
  branch: string,
): Promise<void> {
  const { data } = await context.octokit.rest.repos.get({
    owner: context.owner,
    repo: context.repo,
  })
  if (!data.default_branch || branch === data.default_branch)
    throw new Error("Config API writes cannot target the default branch")
}

export async function listFilesInTreeWithMetadata(
  input: BaseInput & { branch: string },
) {
  return withTransientGitHubRetry(async () => {
    const context = await getInstallationContext(input)
    const head = await getBranchHead({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      branch: input.branch,
    }).catch((error) => {
      if (isEmptyGithubRepositoryError(error)) return null
      throw error
    })
    if (!head) return { files: [], truncated: false }
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

export async function listFilesAtSha(
  input: BaseInput & { sha: string; missing?: "empty" | "throw" },
) {
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
      if (status === 404 || status === 409) {
        if (input.missing === "throw") throw error
        return []
      }
      throw error
    }
  })
}

export type GitHubFileBytes =
  | { kind: "missing" }
  | { kind: "omitted" }
  | { kind: "bytes"; bytes: Buffer }

export async function getFileContentBytes(
  input: BaseInput & { branch: string; path: string },
): Promise<GitHubFileBytes> {
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
        return { kind: "missing" }
      }
      if (isTransientGithubError(error) && a < GITHUB_API_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, githubRetryDelayMs(error, a)))
        continue
      }
      throw error
    }
    if (Array.isArray(data) || !("content" in data)) {
      return { kind: "missing" }
    }
    const encoding =
      "encoding" in data && typeof data.encoding === "string"
        ? data.encoding
        : undefined
    const size = "size" in data && typeof data.size === "number" ? data.size : 0
    if (encoding === "none" || (size > 0 && !data.content)) {
      return { kind: "omitted" }
    }
    if (!data.content) return { kind: "bytes", bytes: Buffer.alloc(0) }
    return { kind: "bytes", bytes: Buffer.from(data.content, "base64") }
  }
  return { kind: "missing" }
}

export async function getFileContent(
  input: BaseInput & { branch: string; path: string },
): Promise<string | undefined> {
  const file = await getFileContentBytes(input)
  if (file.kind === "missing") return undefined
  if (file.kind === "omitted") return ""
  return file.bytes.toString("utf8")
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

type GitTreeEntry = {
  path: string
  mode: "100644"
  type: "blob"
  sha?: string | null
  content?: string
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
  const context = await getInstallationContext(input, { contents: "write" })
  await assertConfigBranch(context, input.branch)
  const fileEntries: GitTreeEntry[] = []
  let lastBinaryBlobStartedAt = 0
  for (const file of input.files) {
    if (file.encoding === "base64") {
      if (lastBinaryBlobStartedAt > 0) {
        const remainingDelay = 1_000 - (Date.now() - lastBinaryBlobStartedAt)
        if (remainingDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingDelay))
        }
      }
      lastBinaryBlobStartedAt = Date.now()
      const blob = await withTransientGitHubRetry(() =>
        context.octokit.rest.git.createBlob({
          owner: context.owner,
          repo: context.repo,
          content: file.content,
          encoding: "base64",
        }),
      )
      fileEntries.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      })
      continue
    }
    fileEntries.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.content,
    })
  }

  const deleteEntries: GitTreeEntry[] = (input.deletePaths ?? []).map(
    (path) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: null,
    }),
  )
  // GitHub creates UTF-8 blobs inside createTree. Deletes count toward the
  // same entry cap so a tree never exceeds 50 entries or ~900 KB of content.
  const maxFiles = 50
  const maxBytes = 900 * 1024
  const chunks: GitTreeEntry[][] = []
  let current: GitTreeEntry[] = []
  let bytes = 0
  const flush = () => {
    if (current.length === 0) return
    chunks.push(current)
    current = []
    bytes = 0
  }
  for (const entry of [...deleteEntries, ...fileEntries]) {
    const size =
      entry.content === undefined ? 0 : Buffer.byteLength(entry.content, "utf8")
    if (size > maxBytes) {
      flush()
      chunks.push([entry])
      continue
    }
    if (
      current.length > 0 &&
      (current.length >= maxFiles || bytes + size > maxBytes)
    ) {
      flush()
    }
    current.push(entry)
    bytes += size
  }
  flush()

  const commitOnce = async (head: { commitSha: string; treeSha: string }) => {
    if (chunks.length === 0) {
      return {
        commitSha: head.commitSha,
        branch: input.branch,
        installationId: context.installation.installationId ?? 0,
      }
    }
    let treeSha = head.treeSha
    for (const chunk of chunks) {
      const { data: tree } = await context.octokit.rest.git.createTree({
        owner: context.owner,
        repo: context.repo,
        base_tree: treeSha,
        tree: chunk,
      })
      treeSha = tree.sha
    }

    const { data: commit } = await context.octokit.rest.git.createCommit({
      owner: context.owner,
      repo: context.repo,
      message: input.message,
      tree: treeSha,
      parents: [head.commitSha],
    })

    await assertConfigBranch(context, input.branch)
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
    const context = await getInstallationContext(input, { contents: "write" })
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
    const context = await getInstallationContext(input, { contents: "write" })
    const head = await getBranchHead({
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
  const context = await getInstallationContext(input, {
    contents: "write",
    pull_requests: "write",
  })
  const base = await getBranchHead({
    octokit: context.octokit,
    owner: context.owner,
    repo: context.repo,
    branch: input.baseBranch,
  })

  const featureBranch =
    input.branch ??
    `${input.featureBranchPrefix ?? "ctxpipe/confluence-config"}-${Date.now()}`
  await assertConfigBranch(context, featureBranch)
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
  const context = await getInstallationContext(input, { pull_requests: "read" })
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
  const context = await getInstallationContext(input, {
    pull_requests: "write",
  })
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

export type GithubPullRequestState = "open" | "closed" | "merged"

export async function getPullRequestState(
  input: BaseInput & { pullNumber: number },
): Promise<{
  prNumber: number
  pullUrl: string
  prState: GithubPullRequestState
  branch: string
  /** The head commit; for a merged PR, the commit GitHub merged. */
  headSha: string
} | null> {
  try {
    const context = await getInstallationContext(input, {
      pull_requests: "read",
    })
    const { data } = await withTransientGitHubRetry(() =>
      context.octokit.rest.pulls.get({
        owner: context.owner,
        repo: context.repo,
        pull_number: input.pullNumber,
      }),
    )
    const prState: GithubPullRequestState = data.merged_at
      ? "merged"
      : data.state === "open"
        ? "open"
        : "closed"
    return {
      prNumber: data.number,
      pullUrl: data.html_url,
      prState,
      branch: data.head.ref,
      headSha: data.head.sha,
    }
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null
    throw error
  }
}

/** GitHub refused the Pull requests: write permission (not a rate limit). */
function isPullRequestPermissionError(error: unknown): boolean {
  const status = (error as { status?: number }).status
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (isTransientGithubError(error)) return false
  return (
    (status === 422 && message.includes("permissions requested")) ||
    (status === 403 &&
      (message.includes("not accessible by integration") ||
        message.includes("permission")))
  )
}

export type PullRequestRefusal = {
  refused: "no_pr_access" | "no_changes"
  githubStatus?: number
  githubMessage: string
}

function refusal(
  refused: PullRequestRefusal["refused"],
  error: unknown,
): PullRequestRefusal {
  return {
    refused,
    githubStatus: (error as { status?: number }).status,
    githubMessage: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Open the pull request. `null`: the Workspace was relinked. A refusal: the
 * App may not open pull requests, or the branch adds no commit.
 */
export async function createPullRequestFromBranch(
  input: BaseInput & {
    revision: WorkspaceRevision
    baseBranch: string
    branch: string
    title: string
    body: string
  },
): Promise<
  | {
      pullNumber: number
      pullUrl: string
      branch: string
      prState: GithubPullRequestState
    }
  | PullRequestRefusal
  | null
> {
  let context: Awaited<ReturnType<typeof getInstallationContext>>
  try {
    context = await getInstallationContext(input, {
      pull_requests: "write",
    })
  } catch (error) {
    if (isPullRequestPermissionError(error))
      return refusal("no_pr_access", error)
    throw error
  }
  try {
    const response = await withTransientGitHubRetry(async () => {
      if (
        !sameWorkspaceRevision(
          await getDesiredWorkspaceRevision(
            input.revision.workspaceId,
            "publish-session",
          ),
          input.revision,
        )
      )
        return null
      return context.octokit.rest.pulls.create({
        owner: context.owner,
        repo: context.repo,
        head: input.branch,
        base: input.baseBranch,
        title: input.title,
        body: input.body,
      })
    })
    if (!response) return null
    const { data: pull } = response
    return {
      pullNumber: pull.number,
      pullUrl: pull.html_url,
      branch: input.branch,
      prState: "open",
    }
  } catch (error) {
    if (isPullRequestPermissionError(error))
      return refusal("no_pr_access", error)
    const status = (error as { status?: number }).status
    if (status !== 422) throw error
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("no commits between")
    )
      return refusal("no_changes", error)
    const { data: existing } = await context.octokit.rest.pulls.list({
      owner: context.owner,
      repo: context.repo,
      head: `${context.owner}:${input.branch}`,
      state: "open",
    })
    const open = existing[0]
    if (!open) throw error
    return {
      pullNumber: open.number,
      pullUrl: open.html_url,
      branch: input.branch,
      prState: "open",
    }
  }
}
