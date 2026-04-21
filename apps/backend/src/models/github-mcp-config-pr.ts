import { Octokit } from "octokit"
import type { Env } from "../config/env.js"
import { getInstallationToken } from "./github-installation.js"

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isOctokitHttpError(
  e: unknown,
): e is Error & { status: number; message: string } {
  return (
    e instanceof Error &&
    e.name === "HttpError" &&
    "status" in e &&
    typeof (e as { status: unknown }).status === "number"
  )
}

/** GitHub 422 when `sha` is not the current tip of the branch (common under concurrent pushes). */
export function isGithubReferenceUpdateFailed(e: unknown): boolean {
  if (!isOctokitHttpError(e) || e.status !== 422) return false
  return e.message.toLowerCase().includes("reference update failed")
}

/** GitHub 422 when `refs/heads/<name>` already exists (extremely rare with random branch names). */
export function isGithubReferenceAlreadyExists(e: unknown): boolean {
  if (!isOctokitHttpError(e) || e.status !== 422) return false
  const m = e.message.toLowerCase()
  return m.includes("already exists") || m.includes("reference already exists")
}

/**
 * Commit SHA at the tip of the default branch via the Git database API (same
 * object `createRef` must point at). Avoids rare mismatches vs `repos.getBranch`.
 */
async function getDefaultBranchHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<string> {
  const refParam = `heads/${defaultBranch}`
  const { data } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: refParam,
  })
  const sha = data.object?.sha
  if (typeof sha !== "string" || sha.length < 40) {
    throw new Error("Unexpected git ref response when resolving default branch")
  }
  return sha
}

async function createHeadRefFromDefaultBranch(input: {
  octokit: Octokit
  owner: string
  repo: string
  branch: string
}): Promise<{ defaultBranch: string }> {
  const { octokit, owner, repo, branch } = input
  const newRef = `refs/heads/${branch}`
  const maxShaAttempts = 6

  for (let attempt = 0; attempt < maxShaAttempts; attempt += 1) {
    const { data: repoMeta } = await octokit.rest.repos.get({
      owner,
      repo,
    })
    const defaultBranch = repoMeta.default_branch
    const baseSha = await getDefaultBranchHeadSha(
      octokit,
      owner,
      repo,
      defaultBranch,
    )

    try {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: newRef,
        sha: baseSha,
      })
      return { defaultBranch }
    } catch (e) {
      if (isGithubReferenceUpdateFailed(e) && attempt < maxShaAttempts - 1) {
        await sleepMs(250 * (attempt + 1))
        continue
      }
      throw e
    }
  }

  throw new Error("Failed to create branch ref after retries")
}

export const MCP_ONBOARDING_AGENTS = [
  "cursor",
  "claude_code",
  "opencode",
] as const

export type McpOnboardingAgent = (typeof MCP_ONBOARDING_AGENTS)[number]

export function mcpStreamUrlForOrg(
  mcpBaseUrl: string,
  orgSlug: string,
): string {
  const base = mcpBaseUrl.replace(/\/$/, "")
  const q = new URLSearchParams({ orgSlug })
  return `${base}/mcp?${q.toString()}`
}

function ctxpipeMcpServerEntry(mcpUrl: string): Record<string, unknown> {
  return {
    type: "streamable-http",
    url: mcpUrl,
  }
}

/** Cursor / Claude Code style: top-level `mcpServers`. */
export function buildOrMergeCursorClaudeMcpJson(
  existingUtf8: string | null,
  mcpUrl: string,
): string {
  const entry = ctxpipeMcpServerEntry(mcpUrl)
  if (existingUtf8) {
    try {
      const parsed = JSON.parse(existingUtf8) as unknown
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "mcpServers" in parsed &&
        typeof (parsed as { mcpServers?: unknown }).mcpServers === "object" &&
        (parsed as { mcpServers?: unknown }).mcpServers !== null &&
        !Array.isArray((parsed as { mcpServers: unknown }).mcpServers)
      ) {
        const prev = parsed as {
          mcpServers: Record<string, unknown>
          [key: string]: unknown
        }
        const merged = {
          ...prev,
          mcpServers: {
            ...prev.mcpServers,
            ctxpipe: entry,
          },
        }
        return `${JSON.stringify(merged, null, 2)}\n`
      }
    } catch {
      // fall through to fresh file
    }
  }
  return `${JSON.stringify({ mcpServers: { ctxpipe: entry } }, null, 2)}\n`
}

/** OpenCode: top-level `mcp` with `type: "remote"`. */
export function buildOrMergeOpenCodeMcpJson(
  existingUtf8: string | null,
  mcpUrl: string,
): string {
  const entry = {
    type: "remote",
    url: mcpUrl,
    enabled: true,
  }
  if (existingUtf8) {
    try {
      const parsed = JSON.parse(existingUtf8) as unknown
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "mcp" in parsed &&
        typeof (parsed as { mcp?: unknown }).mcp === "object" &&
        (parsed as { mcp?: unknown }).mcp !== null &&
        !Array.isArray((parsed as { mcp: unknown }).mcp)
      ) {
        const prev = parsed as {
          mcp: Record<string, unknown>
          [key: string]: unknown
        }
        const merged = {
          ...prev,
          mcp: {
            ...prev.mcp,
            ctxpipe: entry,
          },
        }
        return `${JSON.stringify(merged, null, 2)}\n`
      }
    } catch {
      // fall through
    }
  }
  return `${JSON.stringify({ mcp: { ctxpipe: entry } }, null, 2)}\n`
}

function agentConfigPaths(agent: McpOnboardingAgent): string[] {
  switch (agent) {
    case "cursor":
      return [".cursor/mcp.json"]
    case "claude_code":
      return [".mcp.json"]
    case "opencode":
      return ["opencode.json"]
    default: {
      const _exhaustive: never = agent
      return _exhaustive
    }
  }
}

function buildJsonForAgent(
  agent: McpOnboardingAgent,
  existingUtf8: string | null,
  mcpUrl: string,
): string {
  switch (agent) {
    case "cursor":
    case "claude_code":
      return buildOrMergeCursorClaudeMcpJson(existingUtf8, mcpUrl)
    case "opencode":
      return buildOrMergeOpenCodeMcpJson(existingUtf8, mcpUrl)
    default: {
      const _exhaustive: never = agent
      return _exhaustive
    }
  }
}

async function readTextFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    })
    if (Array.isArray(data) || data.type !== "file") return null
    if (!("content" in data) || typeof data.content !== "string") return null
    return Buffer.from(data.content, "base64").toString("utf8")
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "status" in e &&
      (e as { status: number }).status === 404
    ) {
      return null
    }
    throw e
  }
}

async function getFileShaAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    })
    if (Array.isArray(data) || data.type !== "file" || !("sha" in data))
      return undefined
    return typeof data.sha === "string" ? data.sha : undefined
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "status" in e &&
      (e as { status: number }).status === 404
    ) {
      return undefined
    }
    throw e
  }
}

export type McpConfigPrResultItem = {
  repository: string
  pullRequestUrl: string
}

export type McpConfigPrFailureItem = {
  repository: string
  /** Human-readable message shown to the operator. */
  error: string
  /** HTTP status from GitHub if the failure came from an API call. */
  status?: number
  /** GitHub's documentation_url for the specific error, if returned. */
  documentationUrl?: string
  /** Detailed per-field errors GitHub sometimes returns on 422. */
  errors?: unknown
}

export type McpConfigPrBatchResult = {
  pullRequests: McpConfigPrResultItem[]
  failures: McpConfigPrFailureItem[]
}

/** Pulls GitHub's richer error detail out of an Octokit error, which just
 * surfaces the top-level `message` by default. The `errors[]` array and
 * `documentation_url` frequently disambiguate a 422 (e.g. secondary rate
 * limit vs ruleset vs invalid SHA). */
function extractGithubErrorDetail(e: unknown): {
  status?: number
  documentationUrl?: string
  errors?: unknown
} {
  if (!isOctokitHttpError(e)) return {}
  const anyE = e as {
    status?: number
    response?: { data?: Record<string, unknown> }
  }
  const data = anyE.response?.data
  return {
    status: anyE.status,
    documentationUrl:
      typeof data?.documentation_url === "string"
        ? data.documentation_url
        : undefined,
    errors: Array.isArray(data?.errors) ? data.errors : undefined,
  }
}

/** One row per repository × config path for onboarding preview (reads default branch only). */
export type McpConfigPreviewFile = {
  repository: string
  path: string
  exists: boolean
  existingUtf8: string | null
  mergedUtf8: string
}

/**
 * Reads current MCP config files on each repo’s default branch and returns merged
 * previews matching {@link createCtxpipeMcpConfigPullRequests} (no branch or PR).
 */
export async function previewMcpConfigChanges(input: {
  orgId: string
  orgSlug: string
  env: Env
  repositories: string[]
  agents: McpOnboardingAgent[]
}): Promise<McpConfigPreviewFile[]> {
  const token = await getInstallationToken(input.orgId, input.env)
  if (!token) {
    throw new Error("No GitHub installation token for this organisation")
  }

  const mcpBaseUrl = input.env.AUTH_BASE_URL.replace(/\/$/, "")
  const mcpUrl = mcpStreamUrlForOrg(mcpBaseUrl, input.orgSlug)
  const octokit = new Octokit({ auth: token })

  const out: McpConfigPreviewFile[] = []

  for (const fullName of input.repositories) {
    const [owner, repoName] = fullName.split("/")
    if (!owner || !repoName) continue

    const { data: repoMeta } = await octokit.rest.repos.get({
      owner,
      repo: repoName,
    })
    const defaultBranch = repoMeta.default_branch

    const paths = new Map<
      string,
      { agent: McpOnboardingAgent; existing: string | null; merged: string }
    >()
    for (const agent of input.agents) {
      for (const path of agentConfigPaths(agent)) {
        const existingOnDefault = await readTextFileAtRef(
          octokit,
          owner,
          repoName,
          path,
          defaultBranch,
        )
        paths.set(path, {
          agent,
          existing: existingOnDefault,
          merged: buildJsonForAgent(agent, existingOnDefault, mcpUrl),
        })
      }
    }

    for (const [path, row] of paths) {
      out.push({
        repository: fullName,
        path,
        exists: row.existing !== null,
        existingUtf8: row.existing,
        mergedUtf8: row.merged,
      })
    }
  }

  return out
}

/** One branch name per repository — batch PRs used a single suffix and hit `createRef` collisions. */
export function generateCtxpipeMcpConfigBranchName(): string {
  return `ctxpipe/mcp-config-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Runs the full PR workflow for a single repository. Throws on failure;
 * the caller isolates each repo so one bad apple doesn't drop successful
 * PRs from the batch response. */
async function createCtxpipeMcpConfigPullRequestForRepo(input: {
  octokit: Octokit
  fullName: string
  orgSlug: string
  mcpUrl: string
  agents: McpOnboardingAgent[]
}): Promise<McpConfigPrResultItem | null> {
  const { octokit, fullName, orgSlug, mcpUrl, agents } = input
  const [owner, repoName] = fullName.split("/")
  if (!owner || !repoName) return null

  let branch = generateCtxpipeMcpConfigBranchName()
  let defaultBranch: string | undefined
  const maxBranchNameAttempts = 4
  for (
    let nameAttempt = 0;
    nameAttempt < maxBranchNameAttempts;
    nameAttempt += 1
  ) {
    try {
      ;({ defaultBranch } = await createHeadRefFromDefaultBranch({
        octokit,
        owner,
        repo: repoName,
        branch,
      }))
      break
    } catch (e) {
      if (
        isGithubReferenceAlreadyExists(e) &&
        nameAttempt < maxBranchNameAttempts - 1
      ) {
        branch = generateCtxpipeMcpConfigBranchName()
        continue
      }
      throw e
    }
  }
  if (defaultBranch === undefined) {
    throw new Error("Failed to resolve default branch for MCP config PR")
  }

  const paths = new Map<
    string,
    { agent: McpOnboardingAgent; content: string }
  >()
  for (const agent of agents) {
    for (const path of agentConfigPaths(agent)) {
      const existingOnDefault = await readTextFileAtRef(
        octokit,
        owner,
        repoName,
        path,
        defaultBranch,
      )
      paths.set(path, {
        agent,
        content: buildJsonForAgent(agent, existingOnDefault, mcpUrl),
      })
    }
  }

  for (const [path, { content }] of paths) {
    const shaOnBranch = await getFileShaAtRef(
      octokit,
      owner,
      repoName,
      path,
      branch,
    )
    const shaOnDefault = await getFileShaAtRef(
      octokit,
      owner,
      repoName,
      path,
      defaultBranch,
    )
    const shaForWrite = shaOnBranch ?? shaOnDefault

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path,
      message: `chore: add ctx| MCP config (${path})`,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(shaForWrite ? { sha: shaForWrite } : {}),
    })
  }

  const agentLabels = agents.join(", ")
  const pathList = [...paths.keys()].map((p) => `- \`${p}\``).join("\n")
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo: repoName,
    title: "Add ctx| MCP configuration",
    head: branch,
    base: defaultBranch,
    body: [
      "This PR adds the [ctx|](https://ctxpipe.ai) remote MCP server so your agents can use your organisation context.",
      "",
      `**Organisation slug:** \`${orgSlug}\``,
      `**Agents:** ${agentLabels}`,
      "",
      "**Files**",
      pathList,
      "",
      "Review the diff, merge when ready, and keep credentials out of version control if you customise the config.",
    ].join("\n"),
  })

  if (!pr.html_url) return null
  return { repository: fullName, pullRequestUrl: pr.html_url }
}

export async function createCtxpipeMcpConfigPullRequests(input: {
  orgId: string
  orgSlug: string
  env: Env
  /** GitHub `owner/repo` full names */
  repositories: string[]
  agents: McpOnboardingAgent[]
  /** Optional logger so per-repo failures are visible in evlog without being
   * fatal to the batch. Uses the backend's shared evlog shape (`step`, etc). */
  onRepoFailure?: (ctx: {
    repository: string
    error: unknown
    detail: ReturnType<typeof extractGithubErrorDetail>
  }) => void
}): Promise<McpConfigPrBatchResult> {
  const token = await getInstallationToken(input.orgId, input.env)
  if (!token) {
    throw new Error("No GitHub installation token for this organisation")
  }

  const mcpBaseUrl = input.env.AUTH_BASE_URL.replace(/\/$/, "")
  const mcpUrl = mcpStreamUrlForOrg(mcpBaseUrl, input.orgSlug)
  const octokit = new Octokit({ auth: token })

  const pullRequests: McpConfigPrResultItem[] = []
  const failures: McpConfigPrFailureItem[] = []

  for (const fullName of input.repositories) {
    try {
      const result = await createCtxpipeMcpConfigPullRequestForRepo({
        octokit,
        fullName,
        orgSlug: input.orgSlug,
        mcpUrl,
        agents: input.agents,
      })
      if (result) pullRequests.push(result)
    } catch (e) {
      const detail = extractGithubErrorDetail(e)
      input.onRepoFailure?.({ repository: fullName, error: e, detail })
      failures.push({
        repository: fullName,
        error: e instanceof Error ? e.message : String(e),
        ...(detail.status !== undefined ? { status: detail.status } : {}),
        ...(detail.documentationUrl !== undefined
          ? { documentationUrl: detail.documentationUrl }
          : {}),
        ...(detail.errors !== undefined ? { errors: detail.errors } : {}),
      })
    }
  }

  return { pullRequests, failures }
}
