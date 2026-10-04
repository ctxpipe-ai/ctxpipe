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
import {
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_VERCEL_AGENT_INSTALL,
} from "./chat-runtime.js"
import { WORKSPACE_CHAT_OPENCODE_CLI } from "./workspace-chat-opencode-contract.js"

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

/**
 * Tags on the sandbox that builds a Workspace base. Snapshots carry no tags,
 * so the stopped builder is kept as the base snapshot's owner: the PR-close
 * cleanup finds it by environment and deletes its snapshots with it.
 */
export function workspaceBaseTags(environment: string): Record<string, string> {
  return { ctxpipe: "workspace-base", environment }
}

/**
 * Tags on every builder of an environment's agent snapshot (OpenCode,
 * nothing else); each also carries `opencode: <version>`.
 */
export function agentSnapshotTags(environment: string): Record<string, string> {
  return { ctxpipe: "workspace-agent", environment }
}

/** The `opencode` tag value of this deployment's agent snapshot builders. */
const AGENT_VERSION = WORKSPACE_CHAT_OPENCODE_CLI.replace(/[^\w.-]/g, "-")

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
 * Egress is limited to GitHub and the backend; nothing else, ever (no npm:
 * OpenCode comes from the agent snapshot). The GitHub read token travels in
 * the firewall rule, so it never enters the sandbox.
 */
export function conversationNetworkPolicy(input: {
  gitToken: string
  backendHost: string
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
  /**
   * What a new sandbox starts from, resolved at create: the Workspace base
   * (clone and OpenCode in place) or the agent snapshot (OpenCode only).
   * Never a bare runtime, so no conversation sandbox installs anything.
   */
  startSnapshot: () => Promise<string>
}): SandboxProvider {
  const { credentials, access } = input
  return {
    name: "vercel",
    capabilities: () => ({ ...VERCEL_CAPS, killableProcesses: true }),
    async create() {
      const snapshotId = await input.startSnapshot()
      // Secrets reach the session through `env.set`, not the create request.
      const gitToken = await access.mintGitToken()
      const sandbox = await Sandbox.create({
        ...credentials,
        source: { type: "snapshot", snapshotId },
        ports: [WORKSPACE_CHAT_OPENCODE_PORT],
        persistent: true,
        timeout: SESSION_TIMEOUT_MS,
        snapshotExpiration: STATE_RETENTION_MS,
        keepLastSnapshots: { count: 1, expiration: STATE_RETENTION_MS },
        networkPolicy: conversationNetworkPolicy({ ...access, gitToken }),
        tags: input.tags,
      }).catch((error: unknown) => {
        // The next start looks the agent snapshot up again.
        forgetAgentSnapshot(snapshotId)
        throw error
      })
      await access.tokens.put(sandbox.name, gitToken)
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
      await refreshGitAccess(sandbox, access)
      return conversationHandle(sandbox, input.agentPassword)
    },
    async destroy({ id }) {
      await deleteVercelSandbox({
        credentials,
        name: id,
        tokens: access.tokens,
        ...(access.revokeGitToken ? { revoke: access.revokeGitToken } : {}),
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

async function deleteSnapshot(
  credentials: VercelCredentials,
  snapshotId: string,
): Promise<void> {
  try {
    await (await Snapshot.get({ ...credentials, snapshotId })).delete()
  } catch (error) {
    if (!notFound(error)) throw error
  }
}

/**
 * Delete a builder (Workspace base or agent snapshot) and every snapshot
 * taken from it. Snapshots go first, so a failed sandbox delete never leaves
 * a snapshot nobody can find; `snapshotId` also covers one whose builder is
 * already gone. Already deleted counts as deleted.
 */
export async function deleteVercelBuilder(input: {
  credentials: VercelCredentials
  builderName?: string | null
  snapshotId?: string | null
}): Promise<void> {
  const { credentials, builderName } = input
  if (input.snapshotId) await deleteSnapshot(credentials, input.snapshotId)
  if (!builderName) return
  const taken = await (
    await Snapshot.list({ ...credentials, name: builderName })
  ).toArray()
  for (const { id, status } of taken)
    if (status !== "deleted") await deleteSnapshot(credentials, id)
  try {
    await (
      await Sandbox.get({ ...credentials, name: builderName, resume: false })
    ).delete()
  } catch (error) {
    if (!notFound(error)) throw error
  }
}

/**
 * Sandboxes carrying all of `tags`. The tag filter is the server's; it is
 * checked again before anyone acts on the result.
 */
export async function listTaggedSandboxes(
  credentials: VercelCredentials,
  tags: Record<string, string>,
) {
  return (
    await (await Sandbox.list({ ...credentials, tags })).toArray()
  ).filter((sandbox) =>
    Object.entries(tags).every(([key, value]) => sandbox.tags?.[key] === value),
  )
}

/**
 * Start the sandbox that builds a Workspace base, from the agent snapshot
 * (OpenCode already installed), reaching GitHub only (token in the firewall
 * rule, as for conversations). The caller clones and runs setup on `handle`
 * and then calls `capture`, which snapshots it (stopping it) with
 * `expiration` (0: none). `release` revokes the builder's GitHub token; call
 * it however the build ends.
 */
export async function startVercelWorkspaceBase(input: {
  credentials: VercelCredentials
  agentSnapshotId: string
  mintGitToken: () => Promise<string>
  /** Defaults to GitHub's revoke endpoint. */
  revokeGitToken?: (token: string) => Promise<void>
  backendHost: string
  tags: Record<string, string>
  expiration: number
}): Promise<{
  name: string
  handle: SandboxHandle
  capture: () => Promise<string>
  release: () => Promise<void>
}> {
  const gitToken = await input.mintGitToken()
  let revoked = false
  const release = async () => {
    if (revoked) return
    revoked = true
    await (input.revokeGitToken ?? revokeGithubToken)(gitToken).catch(
      (error: unknown) =>
        log.warn({
          step: "workspace-base-token-revoke",
          message: `Revoking a base builder's GitHub token failed: ${String(error)}`,
        }),
    )
  }
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.create({
      ...input.credentials,
      source: { type: "snapshot", snapshotId: input.agentSnapshotId },
      timeout: 15 * 60_000,
      networkPolicy: conversationNetworkPolicy({
        gitToken,
        backendHost: input.backendHost,
      }),
      tags: input.tags,
    })
  } catch (error) {
    await release()
    throw error
  }
  return {
    name: sandbox.name,
    handle: new VercelHandle({ sandbox, workdir: WORKDIR, ports: [] }),
    capture: async () =>
      (await sandbox.snapshot({ expiration: input.expiration })).snapshotId,
    release,
  }
}

type AgentSnapshot = { snapshotId: string; expiresAt: number }

/**
 * This process's view of the agent snapshot per environment and version, and
 * the build in flight. Builds are deduplicated within a process only; two
 * replicas may each build one, and both are valid.
 */
const agentSnapshots = new Map<string, AgentSnapshot>()
const agentBuilds = new Map<string, Promise<AgentSnapshot>>()

/** Forget a cached agent snapshot that failed to start a sandbox. */
export function forgetAgentSnapshot(snapshotId: string): void {
  for (const [key, cached] of agentSnapshots)
    if (cached.snapshotId === snapshotId) agentSnapshots.delete(key)
}

/**
 * The longest-lived live agent snapshot for this environment and version,
 * found through its tagged builder. Finding nothing only costs a rebuild.
 */
async function findAgentSnapshot(
  credentials: VercelCredentials,
  environment: string,
): Promise<AgentSnapshot | undefined> {
  let best: AgentSnapshot | undefined
  for (const builder of await listTaggedSandboxes(credentials, {
    ...agentSnapshotTags(environment),
    opencode: AGENT_VERSION,
  }))
    for (const snapshot of await (
      await Snapshot.list({ ...credentials, name: builder.name })
    ).toArray()) {
      if (snapshot.status !== "created") continue
      const expiresAt = snapshot.expiresAt ?? Number.POSITIVE_INFINITY
      if (!best || expiresAt > best.expiresAt)
        best = { snapshotId: snapshot.id, expiresAt }
    }
  return best
}

/**
 * Delete this environment's agent builders that no longer hold a live
 * snapshot (older versions, expired snapshots, failed builds) once they are
 * an hour old. Runs after a build, off any conversation's start.
 */
async function deleteSpentAgentBuilders(
  credentials: VercelCredentials,
  environment: string,
): Promise<void> {
  for (const builder of await listTaggedSandboxes(
    credentials,
    agentSnapshotTags(environment),
  )) {
    if (Date.now() - builder.createdAt < 60 * 60_000) continue
    const live = (
      await (
        await Snapshot.list({ ...credentials, name: builder.name })
      ).toArray()
    ).some((snapshot) => snapshot.status === "created")
    if (!live)
      await deleteVercelBuilder({ credentials, builderName: builder.name })
  }
}

/**
 * Install OpenCode in a `node24` sandbox that reaches only the npm registry
 * (no repository, no credential) and snapshot it with a 30-day expiry. The
 * one hosted sandbox that installs anything.
 */
async function buildAgentSnapshot(
  credentials: VercelCredentials,
  environment: string,
): Promise<AgentSnapshot> {
  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: "node24",
    timeout: 15 * 60_000,
    networkPolicy: { allow: ["registry.npmjs.org"] },
    tags: { ...agentSnapshotTags(environment), opencode: AGENT_VERSION },
  })
  try {
    const installed = await new VercelHandle({
      sandbox,
      workdir: WORKDIR,
      ports: [],
    }).process.exec(WORKSPACE_CHAT_VERCEL_AGENT_INSTALL)
    if (installed.exitCode !== 0)
      throw new Error(
        `Installing OpenCode failed (exit ${installed.exitCode}): ${installed.stderr.slice(-500)}`,
      )
    const snapshot = await sandbox.snapshot({ expiration: STATE_RETENTION_MS })
    return {
      snapshotId: snapshot.snapshotId,
      expiresAt:
        snapshot.expiresAt?.getTime() ?? Date.now() + STATE_RETENTION_MS,
    }
  } catch (error) {
    await deleteVercelBuilder({ credentials, builderName: sandbox.name })
    throw error
  }
}

/**
 * The snapshot a conversation without a Workspace base starts from: OpenCode
 * at this deployment's version, nothing else. Cached in the process; looked
 * up through its tagged builder, built when none is found (once per
 * environment and version, and again if builders are ever gone), and
 * replaced in the background in its last week. A failed lookup falls back to
 * a cached snapshot that has not expired.
 */
export async function vercelAgentSnapshot(input: {
  credentials: VercelCredentials
  environment: string
}): Promise<string> {
  const { credentials, environment } = input
  const key = `${environment}:${AGENT_VERSION}`
  const usable = (found?: AgentSnapshot) =>
    found && found.expiresAt - Date.now() > 60 * 60_000 ? found : undefined
  const fresh = (found?: AgentSnapshot) =>
    found && found.expiresAt - Date.now() > 7 * DAY_MS ? found : undefined
  const cached = agentSnapshots.get(key)
  if (fresh(cached)) return (cached as AgentSnapshot).snapshotId
  const build = () => {
    let building = agentBuilds.get(key)
    if (!building) {
      building = buildAgentSnapshot(credentials, environment)
        .then((built) => {
          agentSnapshots.set(key, built)
          void deleteSpentAgentBuilders(credentials, environment).catch(
            (error: unknown) =>
              log.warn({
                step: "workspace-agent-snapshot",
                message: `Deleting spent agent builders failed: ${String(error)}`,
                environment,
              }),
          )
          return built
        })
        .finally(() => agentBuilds.delete(key))
      agentBuilds.set(key, building)
    }
    return building
  }
  let found: AgentSnapshot | undefined
  try {
    found = await findAgentSnapshot(credentials, environment)
  } catch (error) {
    if (usable(cached)) return (cached as AgentSnapshot).snapshotId
    throw error
  }
  if (found) agentSnapshots.set(key, found)
  if (fresh(found)) return (found as AgentSnapshot).snapshotId
  if (usable(found)) {
    // In its last week: still used while a replacement is built.
    build().catch((error: unknown) =>
      log.error({
        step: "workspace-agent-snapshot",
        message: `Replacing the agent snapshot failed: ${String(error)}`,
        environment,
      }),
    )
    return (found as AgentSnapshot).snapshotId
  }
  return (await build()).snapshotId
}
