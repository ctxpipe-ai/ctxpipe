import { Octokit } from "octokit"
import type { Env } from "../config/env.js"
import { getInstallationToken } from "./github-installation.js"

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

export async function createCtxpipeMcpConfigPullRequests(input: {
  orgId: string
  orgSlug: string
  env: Env
  /** GitHub `owner/repo` full names */
  repositories: string[]
  agents: McpOnboardingAgent[]
}): Promise<McpConfigPrResultItem[]> {
  const token = await getInstallationToken(input.orgId, input.env)
  if (!token) {
    throw new Error("No GitHub installation token for this organisation")
  }

  const mcpBaseUrl = input.env.AUTH_BASE_URL.replace(/\/$/, "")
  const mcpUrl = mcpStreamUrlForOrg(mcpBaseUrl, input.orgSlug)
  const octokit = new Octokit({ auth: token })

  const results: McpConfigPrResultItem[] = []

  for (const fullName of input.repositories) {
    const [owner, repoName] = fullName.split("/")
    if (!owner || !repoName) continue

    const { data: repoMeta } = await octokit.rest.repos.get({
      owner,
      repo: repoName,
    })
    const defaultBranch = repoMeta.default_branch

    const { data: branchRef } = await octokit.rest.repos.getBranch({
      owner,
      repo: repoName,
      branch: defaultBranch,
    })
    const baseSha = branchRef.commit.sha

    const branch = generateCtxpipeMcpConfigBranchName()
    await octokit.rest.git.createRef({
      owner,
      repo: repoName,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    })

    const paths = new Map<
      string,
      { agent: McpOnboardingAgent; content: string }
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

    const agentLabels = input.agents.join(", ")
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
        `**Organisation slug:** \`${input.orgSlug}\``,
        `**Agents:** ${agentLabels}`,
        "",
        "**Files**",
        pathList,
        "",
        "Review the diff, merge when ready, and keep credentials out of version control if you customise the config.",
      ].join("\n"),
    })

    if (pr.html_url) {
      results.push({ repository: fullName, pullRequestUrl: pr.html_url })
    }
  }

  return results
}
