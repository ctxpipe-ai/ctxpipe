import { createHmac } from "node:crypto"
import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { VERCEL_CAPS, VercelHandle } from "@tanstack/ai-sandbox-vercel"
import {
  APIError,
  type NetworkPolicy,
  Sandbox,
  Snapshot,
} from "@vercel/sandbox"
import type { SandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
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

/**
 * Tags on every hosted chat sandbox. `environment` is the Railway environment
 * name, so a closed PR preview's sandboxes can be found and deleted.
 */
export function conversationSandboxTags(
  environment: string,
): Record<string, string> {
  return { ctxpipe: "workspace-chat", environment }
}

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

export async function revokeGithubToken(token: string): Promise<void> {
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

function revokeLater(
  token: string | undefined,
  sandboxId: string,
  revoke: (token: string) => Promise<void>,
) {
  if (!token) return
  setTimeout(() => {
    revoke(token).catch((error: unknown) =>
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
  /**
   * The sandbox's current token. Vercel redacts header values, so this is
   * the only copy, used to rotate and revoke it.
   */
  tokens: SandboxGitTokenStore
  /** Defaults to GitHub's revoke endpoint. */
  revokeGitToken?: (token: string) => Promise<void>
  backendHost: string
  extraHosts?: string[]
}

/** Replace the sandbox's GitHub token and revoke the old one after a grace. */
async function rotateGitToken(
  sandbox: Sandbox,
  access: ConversationSandboxAccess,
  previous: string | undefined,
) {
  const gitToken = await access.mintGitToken()
  await sandbox.update({
    networkPolicy: conversationNetworkPolicy({ ...access, gitToken }),
  })
  await access.tokens.put(sandbox.name, gitToken)
  revokeLater(
    previous,
    sandbox.name,
    access.revokeGitToken ?? revokeGithubToken,
  )
}

/**
 * Keep the token fresh without delaying turns: a token younger than 10
 * minutes is left alone; an older one is rotated in the background (it stays
 * valid until it is replaced). Only a missing token, after a stop, is
 * replaced before the sandbox is used.
 */
async function refreshGitAccess(
  sandbox: Sandbox,
  access: ConversationSandboxAccess,
): Promise<void> {
  const current = await access.tokens.get(sandbox.name)
  if (!current) {
    await rotateGitToken(sandbox, access, undefined)
    return
  }
  if (Date.now() - current.mintedAt.getTime() < GIT_TOKEN_ROTATE_MS) return
  rotateGitToken(sandbox, access, current.token).catch((error: unknown) =>
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
        tags: input.tags,
      })
      await input.access.tokens.put(sandbox.name, gitToken)
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
      await deleteVercelSandbox({
        credentials,
        name: id,
        tokens: input.access.tokens,
        ...(input.access.revokeGitToken
          ? { revoke: input.access.revokeGitToken }
          : {}),
      })
    },
  }
}

type SandboxTarget = {
  credentials: VercelCredentials
  name: string
  /**
   * Where the sandbox's GitHub token is kept, so it can be revoked. PR-close
   * cleanup has none: the preview's database is deleted with the preview, and
   * a token that is not revoked expires within an hour.
   */
  tokens?: SandboxGitTokenStore
  revoke?: (token: string) => Promise<void>
}

function notFound(error: unknown): boolean {
  return error instanceof APIError && error.response.status === 404
}

async function revokeSandboxToken(target: SandboxTarget): Promise<void> {
  const token = await target.tokens?.take(target.name)
  if (token) await (target.revoke ?? revokeGithubToken)(token)
}

/**
 * Stop a sandbox (its files are saved) and revoke its GitHub token; already
 * gone counts as stopped.
 */
export async function stopVercelSandbox(target: SandboxTarget): Promise<void> {
  try {
    const sandbox = await Sandbox.get({
      ...target.credentials,
      name: target.name,
      resume: false,
    })
    await sandbox.stop()
  } catch (error) {
    if (!notFound(error)) throw error
  }
  await revokeSandboxToken(target)
}

/** A command handle on a sandbox, resumed from its saved state if stopped. */
export async function attachVercelSandbox(
  target: SandboxTarget,
): Promise<SandboxHandle | null> {
  try {
    const sandbox = await Sandbox.get({
      ...target.credentials,
      name: target.name,
    })
    return new VercelHandle({ sandbox, workdir: WORKDIR, ports: [] })
  } catch (error) {
    if (notFound(error)) return null
    throw error
  }
}

/** Delete a sandbox and its saved state; already gone counts as deleted. */
export async function deleteVercelSandbox(
  target: SandboxTarget,
): Promise<void> {
  const { credentials, name } = target
  try {
    const sandbox = await Sandbox.get({ ...credentials, name, resume: false })
    await sandbox.delete()
  } catch (error) {
    if (!notFound(error)) throw error
  }
  // Saved snapshots can outlive the sandbox; delete what is left.
  const saved = await (await Snapshot.list({ ...credentials, name })).toArray()
  for (const { id, status } of saved) {
    if (status === "deleted") continue
    try {
      await (await Snapshot.get({ ...credentials, snapshotId: id })).delete()
    } catch (error) {
      if (!notFound(error)) throw error
    }
  }
  await revokeSandboxToken(target)
}
