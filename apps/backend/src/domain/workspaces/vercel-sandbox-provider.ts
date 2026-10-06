import { createHmac } from "node:crypto"
import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { VERCEL_CAPS, VercelHandle } from "@tanstack/ai-sandbox-vercel"
import {
  APIError,
  type NetworkPolicy,
  Sandbox,
  Snapshot,
} from "@vercel/sandbox"
import { assertNotInOrgDbContext } from "../../db/client.js"
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
 * `environment` is the first tag because `listTaggedSandboxes` filters on the
 * first tag: one environment has fewer chats than all environments.
 */
export function conversationSandboxTags(
  environment: string,
): Record<string, string> {
  return { environment, ctxpipe: "workspace-chat" }
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
  return {
    allow: { ...githubAllowlist(input.gitToken), [input.backendHost]: [] },
  }
}

/** GitHub hosts, each with the read token added by the firewall. */
function githubAllowlist(gitToken: string) {
  const basic = Buffer.from(`x-access-token:${gitToken}`).toString("base64")
  return {
    "github.com": [
      { transform: [{ headers: { authorization: `Basic ${basic}` } }] },
    ],
    "codeload.github.com": [
      { transform: [{ headers: { authorization: `Basic ${basic}` } }] },
    ],
    "api.github.com": [
      { transform: [{ headers: { authorization: `Bearer ${gitToken}` } }] },
    ],
  }
}

/**
 * Builder snapshots on a PR preview expire after 30 days, so a PR-close
 * cleanup that misses a builder leaves a bounded leftover. Production ones
 * have no expiry; they are deleted from their rows (bases) or when another
 * OpenCode version replaces them (agent snapshots).
 */
export function builderSnapshotExpiration(environment: string): number {
  return /^pr-\d+$/.test(environment) ? STATE_RETENTION_MS : 0
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
   * The Workspace base a new sandbox starts from (clone and OpenCode in
   * place), resolved at create, and how to mark it failed.
   */
  base: () => Promise<{ ref?: string; failed: () => Promise<void> }>
  /** Without a base: the agent snapshot (OpenCode only). Never a bare runtime. */
  agentSnapshot: () => Promise<string>
  /** Added to this provider's log entries. */
  logContext?: { orgId: string; workspaceId: string }
}): SandboxProvider {
  const { credentials, access } = input
  return {
    name: "vercel",
    capabilities: () => ({ ...VERCEL_CAPS, killableProcesses: true }),
    async create() {
      // Secrets reach the session through `env.set`, not the create request.
      const gitToken = await access.mintGitToken()
      const start = (snapshotId: string) =>
        Sandbox.create({
          ...credentials,
          source: { type: "snapshot", snapshotId },
          ports: [WORKSPACE_CHAT_OPENCODE_PORT],
          persistent: true,
          timeout: SESSION_TIMEOUT_MS,
          snapshotExpiration: STATE_RETENTION_MS,
          keepLastSnapshots: { count: 1, expiration: STATE_RETENTION_MS },
          networkPolicy: conversationNetworkPolicy({ ...access, gitToken }),
          tags: input.tags,
        })
      const fromAgent = async () => {
        const snapshotId = await input.agentSnapshot()
        return start(snapshotId).catch((error: unknown) => {
          // The next start looks the agent snapshot up again.
          forgetAgentSnapshot(snapshotId)
          throw error
        })
      }
      const base = await input.base()
      let sandbox: Sandbox
      if (base.ref) {
        try {
          sandbox = await start(base.ref)
        } catch (error) {
          // This start goes on from the agent snapshot, once. The base is
          // marked failed (cleanup removes it, the next start asks for a
          // rebuild) only when it is the cause: a read of the snapshot finds
          // it gone or not usable. Any other failure keeps it.
          log.warn({
            step: "workspace-base-start",
            message: `Starting from the Workspace base failed; using the agent snapshot: ${String(error)}`,
            ...input.logContext,
          })
          if (await baseSnapshotIsBad(credentials, base.ref))
            await base.failed()
          sandbox = await fromAgent()
        }
      } else sandbox = await fromAgent()
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

/**
 * Whether a failed start from a Workspace base was the base's fault: the
 * snapshot is now gone or not `created`. The start's own error does not
 * decide it, as a client error can be about another option. When the check
 * itself fails, the base is kept.
 */
async function baseSnapshotIsBad(
  credentials: VercelCredentials,
  snapshotId: string,
): Promise<boolean> {
  try {
    const snapshot = await Snapshot.get({ ...credentials, snapshotId })
    return snapshot.status !== "created"
  } catch (checkError) {
    return notFound(checkError)
  }
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

/**
 * A command handle on a sandbox, resumed from its saved state if stopped.
 * The handle gets no GitHub token: the push before a deletion runs only local
 * Git commands in the sandbox, and the broker holds the tokens.
 */
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
 * Sandboxes carrying all of `tags`. The Vercel API filters a list on one tag
 * only, and it rejects a request with more tags (400). Thus the server
 * filters on the first tag, and this function checks all of the tags. Put
 * the most selective tag first.
 */
export async function listTaggedSandboxes(
  credentials: VercelCredentials,
  tags: Record<string, string>,
) {
  const [first] = Object.entries(tags)
  if (!first) throw new Error("listTaggedSandboxes needs at least one tag")
  return (
    await (
      await Sandbox.list({ ...credentials, tags: { [first[0]]: first[1] } })
    ).toArray()
  ).filter((sandbox) =>
    Object.entries(tags).every(([key, value]) => sandbox.tags?.[key] === value),
  )
}

/**
 * Start the sandbox that builds a Workspace base, from the agent snapshot
 * (OpenCode already installed). It reaches GitHub only, with the read token
 * in the firewall rule. The caller clones and runs setup on `handle`, then
 * calls `capture`, which snapshots it (stopping it) with `expiration` (0:
 * none). `finish` revokes the builder's GitHub token; the caller calls it
 * once, however the build ends.
 */
export async function startVercelWorkspaceBase(input: {
  credentials: VercelCredentials
  agentSnapshotId: string
  mintGitToken: () => Promise<string>
  /** Defaults to GitHub's revoke endpoint. */
  revokeGitToken?: (token: string) => Promise<void>
  tags: Record<string, string>
  expiration: number
}): Promise<{
  builderId: string
  handle: SandboxHandle
  capture: () => Promise<string>
  finish: () => Promise<void>
}> {
  assertNotInOrgDbContext()
  const gitToken = await input.mintGitToken()
  const finish = () =>
    (input.revokeGitToken ?? revokeGithubToken)(gitToken).catch(
      (error: unknown) =>
        log.warn({
          step: "workspace-base-token-revoke",
          message: `Revoking a base builder's GitHub token failed: ${String(error)}`,
        }),
    )
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.create({
      ...input.credentials,
      source: { type: "snapshot", snapshotId: input.agentSnapshotId },
      timeout: 15 * 60_000,
      networkPolicy: { allow: githubAllowlist(gitToken) },
      tags: input.tags,
    })
  } catch (error) {
    await finish()
    throw error
  }
  return {
    builderId: sandbox.name,
    handle: new VercelHandle({ sandbox, workdir: WORKDIR, ports: [] }),
    capture: async () =>
      (await sandbox.snapshot({ expiration: input.expiration })).snapshotId,
    finish,
  }
}

/**
 * This process's agent snapshot per environment and OpenCode version, and
 * the build in flight. Builds are deduplicated within a process only; two
 * replicas may each build one, and both are valid.
 */
const agentSnapshots = new Map<string, string>()
const agentBuilds = new Map<string, Promise<string>>()

/** Forget a cached agent snapshot that failed to start a sandbox. */
export function forgetAgentSnapshot(snapshotId: string): void {
  for (const [key, cached] of agentSnapshots)
    if (cached === snapshotId) agentSnapshots.delete(key)
}

/** A live agent snapshot for this environment and version, found through its tagged builder. */
async function findAgentSnapshot(
  credentials: VercelCredentials,
  environment: string,
): Promise<string | undefined> {
  for (const builder of await listTaggedSandboxes(credentials, {
    ...agentSnapshotTags(environment),
    opencode: AGENT_VERSION,
  }))
    for (const snapshot of await (
      await Snapshot.list({ ...credentials, name: builder.name })
    ).toArray())
      if (snapshot.status === "created") return snapshot.id
  return undefined
}

/**
 * Delete this environment's agent builders of other OpenCode versions, and
 * any (an hour old, so not a build in progress) with no live snapshot.
 * Runs after a build, off any conversation's start.
 */
async function deleteOldAgentBuilders(
  credentials: VercelCredentials,
  environment: string,
): Promise<void> {
  for (const builder of await listTaggedSandboxes(
    credentials,
    agentSnapshotTags(environment),
  )) {
    if (Date.now() - builder.createdAt < 60 * 60_000) continue
    const current = builder.tags?.opencode === AGENT_VERSION
    const live =
      current &&
      (
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
 * (no repository, no credential) and snapshot it. The one hosted sandbox
 * that installs anything.
 */
async function buildAgentSnapshot(
  credentials: VercelCredentials,
  environment: string,
): Promise<string> {
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
    return (
      await sandbox.snapshot({
        expiration: builderSnapshotExpiration(environment),
      })
    ).snapshotId
  } catch (error) {
    await deleteVercelBuilder({ credentials, builderName: sandbox.name })
    throw error
  }
}

/**
 * The snapshot a conversation without a Workspace base starts from: OpenCode
 * at this deployment's version, nothing else. Cached in the process; found
 * through its tagged builder, or built when none is found (once per
 * environment and version, and again if builders are ever gone).
 */
export async function vercelAgentSnapshot(input: {
  credentials: VercelCredentials
  environment: string
}): Promise<string> {
  assertNotInOrgDbContext()
  const { credentials, environment } = input
  const key = `${environment}:${AGENT_VERSION}`
  const cached = agentSnapshots.get(key)
  if (cached) return cached
  const found = await findAgentSnapshot(credentials, environment)
  if (found) {
    agentSnapshots.set(key, found)
    return found
  }
  let building = agentBuilds.get(key)
  if (!building) {
    building = buildAgentSnapshot(credentials, environment)
      .then((built) => {
        agentSnapshots.set(key, built)
        void deleteOldAgentBuilders(credentials, environment).catch(
          (error: unknown) =>
            log.warn({
              step: "workspace-agent-snapshot",
              message: `Deleting old agent builders failed: ${String(error)}`,
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
