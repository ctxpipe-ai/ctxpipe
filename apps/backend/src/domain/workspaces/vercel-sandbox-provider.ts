import { createHmac } from "node:crypto"
import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { VERCEL_CAPS, VercelHandle } from "@tanstack/ai-sandbox-vercel"
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox"
import { log } from "../../observability/logger.js"
import { WORKSPACE_CHAT_OPENCODE_PORT } from "./chat-runtime.js"

/** Where the stock Vercel handle maps the `/workspace` root. */
const WORKDIR = "/vercel/sandbox"
const DAY_MS = 24 * 60 * 60_000
/** A conversation's saved state is deleted 30 days after its last stop. */
const STATE_RETENTION_MS = 30 * DAY_MS
/** Backstop only; our cleanup stops a sandbox after 5 minutes idle. */
const SESSION_TIMEOUT_MS = 45 * 60_000
/** A sandbox keeps one GitHub token this long before it is rotated. */
export const GIT_TOKEN_ROTATE_MS = 10 * 60_000
/** In-flight git calls finish on the old token before it is revoked. */
const GIT_TOKEN_REVOKE_GRACE_MS = 30_000
/** Sandbox tag holding when its GitHub token was minted ("0" once revoked). */
const GIT_TOKEN_TAG = "git-token-at"

export type VercelCredentials = {
  token: string
  teamId: string
  projectId: string
}

let resolvedScope: Promise<VercelCredentials> | undefined

/**
 * The deploy passes the team and project by slug or id. Team-scoped tokens
 * cannot read the team itself, so both ids come from the project lookup,
 * once per process.
 */
export function vercelCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VercelCredentials> {
  const token = env.VERCEL_TOKEN?.trim()
  const team = env.VERCEL_TEAM_ID?.trim()
  const project = env.VERCEL_PROJECT_ID?.trim()
  if (!token || !team || !project)
    return Promise.reject(
      new Error(
        "Vercel sandboxes need VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID",
      ),
    )
  if (team.startsWith("team_") && project.startsWith("prj_"))
    return Promise.resolve({ token, teamId: team, projectId: project })
  resolvedScope ??= (async () => {
    const query = team.startsWith("team_") ? "teamId" : "slug"
    const response = await fetch(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}?${query}=${encodeURIComponent(team)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!response.ok)
      throw new Error(`Vercel project lookup failed with ${response.status}`)
    const body = (await response.json()) as { id: string; accountId: string }
    return { token, teamId: body.accountId, projectId: body.id }
  })().catch((error: unknown) => {
    resolvedScope = undefined
    throw error
  })
  return resolvedScope
}

/** The conversation's agent-port password; derived, so any replica can rebuild it. */
export function conversationAgentPassword(
  authSecret: string,
  conversationId: string,
): string {
  return createHmac("sha256", authSecret)
    .update(`workspace-chat-agent:${conversationId}`)
    .digest("hex")
}

/**
 * Egress is limited to GitHub and the backend. The GitHub read token travels
 * in the firewall rule, so it never enters the sandbox.
 */
export function conversationNetworkPolicy(input: {
  gitToken: string
  backendHost: string
  extraHosts?: string[]
}): NetworkPolicy {
  const basic = Buffer.from(`x-access-token:${input.gitToken}`).toString(
    "base64",
  )
  return {
    allow: {
      "github.com": [
        { transform: [{ headers: { authorization: `Basic ${basic}` } }] },
      ],
      "codeload.github.com": [
        { transform: [{ headers: { authorization: `Basic ${basic}` } }] },
      ],
      "api.github.com": [
        {
          transform: [
            { headers: { authorization: `Bearer ${input.gitToken}` } },
          ],
        },
      ],
      [input.backendHost]: [],
      ...Object.fromEntries((input.extraHosts ?? []).map((host) => [host, []])),
    },
  }
}

/** The GitHub token a policy carries, so it can be revoked once replaced. */
function policyGitToken(policy: NetworkPolicy | undefined): string | undefined {
  if (!policy || typeof policy === "string" || Array.isArray(policy.allow))
    return undefined
  const header = policy.allow?.["api.github.com"]?.[0]?.transform?.[0]?.headers
    ?.authorization
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined
}

async function revokeGithubToken(token: string): Promise<void> {
  const response = await fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
    },
  })
  // 401: already expired or revoked.
  if (!response.ok && response.status !== 401)
    throw new Error(`GitHub token revoke failed with ${response.status}`)
}

function revokeLater(token: string | undefined, sandboxId: string) {
  if (!token) return
  setTimeout(() => {
    revokeGithubToken(token).catch((error: unknown) =>
      log.warn({
        step: "workspace-chat-git-token-revoke",
        message: `Revoking a replaced sandbox GitHub token failed: ${String(error)}`,
        sandboxId,
      }),
    )
  }, GIT_TOKEN_REVOKE_GRACE_MS).unref?.()
}

export type ConversationSandboxAccess = {
  /** Mints a fresh read token for the Workspace (never a cached one). */
  mintGitToken: () => Promise<string>
  backendHost: string
  extraHosts?: string[]
}

/** Replace the sandbox's GitHub token and revoke the old one after a grace. */
async function rotateGitToken(sandbox: Sandbox, access: ConversationSandboxAccess) {
  const previous = policyGitToken(sandbox.networkPolicy)
  const gitToken = await access.mintGitToken()
  await sandbox.update({
    networkPolicy: conversationNetworkPolicy({ ...access, gitToken }),
    tags: { ...sandbox.tags, [GIT_TOKEN_TAG]: String(Date.now()) },
  })
  revokeLater(previous, sandbox.name)
}

/**
 * Keep the token fresh without delaying turns: a token younger than 10
 * minutes is left alone; an older one is rotated in the background (it stays
 * valid until replaced). Only a revoked token, after a stop, is replaced
 * before the sandbox is used.
 */
async function refreshGitAccess(
  sandbox: Sandbox,
  access: ConversationSandboxAccess,
): Promise<void> {
  const mintedAt = Number(sandbox.tags?.[GIT_TOKEN_TAG] ?? 0)
  if (mintedAt === 0) {
    await rotateGitToken(sandbox, access)
    return
  }
  if (Date.now() - mintedAt < GIT_TOKEN_ROTATE_MS) return
  rotateGitToken(sandbox, access).catch((error: unknown) =>
    log.warn({
      step: "workspace-chat-git-token-rotate",
      message: `Rotating a sandbox GitHub token failed: ${String(error)}`,
      sandboxId: sandbox.name,
    }),
  )
}

/** The stock handle, with the agent port behind the OpenCode password and kill enabled. */
function conversationHandle(
  sandbox: Sandbox,
  agentPassword: string,
): SandboxHandle {
  const handle = new VercelHandle({
    sandbox,
    workdir: WORKDIR,
    ports: [WORKSPACE_CHAT_OPENCODE_PORT],
  })
  // Set here, not only in workspace secrets, so `opencode serve` can never
  // start without a password on a public port.
  void handle.env.set({ OPENCODE_SERVER_PASSWORD: agentPassword })
  const authorization = `Basic ${Buffer.from(`opencode:${agentPassword}`).toString("base64")}`
  return {
    id: handle.id,
    provider: handle.provider,
    workspaceRoot: handle.workspaceRoot,
    // Measured against real sandboxes: Command.kill also stops children.
    capabilities: { ...VERCEL_CAPS, killableProcesses: true },
    fs: handle.fs,
    git: handle.git,
    process: handle.process,
    env: handle.env,
    ports: {
      connect: async (port) => ({
        ...(await handle.ports.connect(port)),
        headers: { Authorization: authorization },
      }),
    },
    destroy: () => handle.destroy(),
  }
}

/**
 * Hosted conversation sandboxes: persistent Vercel microVMs that save their
 * files on stop and keep them 30 days. Built on the stock `VercelHandle`; we
 * own create so the firewall, retention and start source are ours.
 */
export function vercelConversationProvider(input: {
  credentials: VercelCredentials
  agentPassword: string
  access: ConversationSandboxAccess
  tags: Record<string, string>
  /** The Workspace base snapshot; without one the sandbox starts empty. */
  baseSnapshotId?: string
}): SandboxProvider {
  const { credentials } = input
  return {
    name: "vercel",
    capabilities: () => ({ ...VERCEL_CAPS, killableProcesses: true }),
    async create() {
      // Secrets reach the session through `env.set`, not the create request.
      const gitToken = await input.access.mintGitToken()
      const sandbox = await Sandbox.create({
        ...credentials,
        ...(input.baseSnapshotId
          ? {
              source: {
                type: "snapshot" as const,
                snapshotId: input.baseSnapshotId,
              },
            }
          : { runtime: "node24" }),
        ports: [WORKSPACE_CHAT_OPENCODE_PORT],
        persistent: true,
        timeout: SESSION_TIMEOUT_MS,
        snapshotExpiration: STATE_RETENTION_MS,
        keepLastSnapshots: { count: 1, expiration: STATE_RETENTION_MS },
        networkPolicy: conversationNetworkPolicy({ ...input.access, gitToken }),
        tags: { ...input.tags, [GIT_TOKEN_TAG]: String(Date.now()) },
      })
      return conversationHandle(sandbox, input.agentPassword)
    },
    async resume({ id }) {
      let sandbox: Sandbox
      try {
        sandbox = await Sandbox.get({ ...credentials, name: id })
      } catch {
        // Deleted or past retention: TanStack creates a new one.
        return null
      }
      await refreshGitAccess(sandbox, input.access)
      return conversationHandle(sandbox, input.agentPassword)
    },
    async destroy({ id }) {
      await deleteVercelSandbox(credentials, id)
    },
  }
}

/** Stop a sandbox (its files are saved) and revoke its GitHub token. */
export async function stopVercelSandbox(
  credentials: VercelCredentials,
  name: string,
): Promise<void> {
  const sandbox = await Sandbox.get({ ...credentials, name, resume: false })
  const token = policyGitToken(sandbox.networkPolicy)
  await sandbox.update({ tags: { ...sandbox.tags, [GIT_TOKEN_TAG]: "0" } })
  await sandbox.stop()
  if (token) await revokeGithubToken(token)
}

/** Delete a sandbox and its saved state; already gone counts as deleted. */
export async function deleteVercelSandbox(
  credentials: VercelCredentials,
  name: string,
): Promise<void> {
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.get({ ...credentials, name, resume: false })
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status === 404)
      return
    throw error
  }
  const token = policyGitToken(sandbox.networkPolicy)
  await sandbox.delete()
  if (token) await revokeGithubToken(token)
}
