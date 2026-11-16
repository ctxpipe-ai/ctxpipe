import { randomUUID } from "node:crypto"

import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"

import { withOrgDbContext } from "../../db/client.js"
import {
  claimPoolSession,
  deleteSandboxInstance,
  listSandboxInstances,
  ownershipOf,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import type { RunVault } from "./agent-vault.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import type { WorkspaceRevision } from "./revision.js"
import { markSandboxLifecycle } from "./sandbox-lifecycle-timing.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"

/**
 * The warm pool of AgentCore chat sessions (CTX-1323, ADR-061 decision 18).
 * A pool session holds the clone of its Workspace repository and nothing
 * else. A new conversation of the Workspace claims it, and the stock
 * bootstrap then skips the clone because `/workspace/.git` exists. Each
 * session is claimed once: the claim deletes its row.
 *
 * A fill clones through its own Agent Vault vault, which holds only the
 * GitHub read rules of the Workspace. The fill closes that vault before the
 * session waits. A waiting session thus has no proxy session, and the
 * sandbox network has no other way out: it has no egress and no credential.
 */

/**
 * A ready session waits this long. AgentCore stops a session after 15
 * minutes without a call, so a claim finds the session still running.
 */
export const POOL_SESSION_TTL_MS = 12 * 60_000

/** A fill that has not finished after this long is lost: the sweep stops it. */
const POOL_FILL_LEASE_MS = 30 * 60_000

/** The image value of a pool row: the AgentCore chat sandboxes' key value. */
const POOL_IMAGE = "agentcore-agent"

/**
 * Claim a ready pool session of the Workspace on `create`, or create a new
 * session when none is ready. The claimed session's marker check (`resume`)
 * also tells a session that AgentCore stopped from one that runs: a stopped
 * one gives a cold create.
 */
export function withPoolClaim(
  provider: SandboxProvider,
  owner: { orgId: string; workspaceId: string; revision: WorkspaceRevision },
): SandboxProvider {
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    async create(input) {
      const started = Date.now()
      // Only a session with at least a minute of its wait left: the sweep
      // stops a session at the end of its wait, and the clocks of the
      // backend and the worker can differ a little.
      const sessionId = await claimPoolSession({
        ...owner,
        readySince: new Date(started - POOL_SESSION_TTL_MS + 60_000),
      })
      const handle = sessionId ? await provider.resume({ id: sessionId }) : null
      markSandboxLifecycle("pool-claim", {
        outcome: handle ? "hit" : sessionId ? "gone" : "miss",
        workspaceId: owner.workspaceId,
        ms: Date.now() - started,
      })
      return handle ?? provider.create(input)
    },
    resume: (input) => provider.resume(input),
    destroy: (input) => provider.destroy(input),
  }
}

/** The pool sessions of one Workspace and of one organization. */
const WORKSPACE_POOL_SIZE = 1
const ORG_POOL_LIMIT = 3

/** A pool row that still holds or will hold a usable session. */
function poolRowCurrent(row: SandboxInstanceRecord, now: number): boolean {
  const age = now - row.lastHeartbeatAt.getTime()
  if (row.state === "live") return age < POOL_SESSION_TTL_MS
  if (row.state === "building") return age < POOL_FILL_LEASE_MS
  return false
}

/** Whether a pool row is due for the sweep, and when it will be. */
export function poolRowDueAt(row: SandboxInstanceRecord): number {
  const at = row.lastHeartbeatAt.getTime()
  if (row.state === "live") return at + POOL_SESSION_TTL_MS
  if (row.state === "building") return at + POOL_FILL_LEASE_MS
  return at
}

function sameRepository(a: WorkspaceRevision, b: WorkspaceRevision) {
  return (
    a.remote.url === b.remote.url &&
    (a.remote.connectionId ?? "") === (b.remote.connectionId ?? "") &&
    a.generation === b.generation
  )
}

/**
 * Fill one pool session for the Workspace, if the Workspace and the
 * organization are under their limits. Returns `full` when it made none.
 */
export async function fillChatSandboxPool(input: {
  orgId: string
  workspaceId: string
  revision: WorkspaceRevision
  /** The provider of a pool session, which trusts the vault's CA. */
  provider: (caPem: string | undefined) => SandboxProvider
  /** The fill's own vault, GitHub read rules only, by its run key. */
  openVault: (runKey: string) => Promise<RunVault>
}): Promise<"filled" | "full"> {
  const { orgId, workspaceId, revision } = input
  const started = Date.now()
  const id = `pool-${randomUUID()}`
  const reserved: SandboxInstanceRecord = {
    id,
    kind: "pool",
    orgId,
    workspaceId,
    conversationId: null,
    provider: "agentcore",
    providerSandboxId: null,
    image: POOL_IMAGE,
    revision,
    state: "building",
    lastHeartbeatAt: new Date(),
  }
  /** Reserve the row, if the Workspace and the organization have room. */
  const reserve = () =>
    postgresSandboxLocks(orgId).withLock("chat-sandbox-pool", async () => {
      const now = Date.now()
      const current = (
        await withOrgDbContext(orgId, () =>
          listSandboxInstances({ kind: "pool" }),
        )
      ).filter((row) => poolRowCurrent(row, now))
      const ofWorkspace = current.filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.revision &&
          sameRepository(row.revision, revision),
      )
      if (
        ofWorkspace.length >= WORKSPACE_POOL_SIZE ||
        current.length >= ORG_POOL_LIMIT
      )
        return false
      await persistSandboxInstance(reserved)
      return true
    })
  // The row's own lock is taken before the row exists: a Workspace delete or
  // relink that finds the row waits for the fill, then stops the session.
  const outcome = await postgresSandboxLocks(orgId).withLock(
    `sandbox:${id}`,
    async () => {
      if (!(await reserve())) return "full" as const
      let row: SandboxInstanceRecord = reserved
      let handle: SandboxHandle | undefined
      try {
        const vault = await input.openVault(id)
        try {
          handle = await input.provider(vault.caPem).create({ id })
          row = { ...row, providerSandboxId: handle.id }
          await persistSandboxInstance(row, ownershipOf(reserved))
          await handle.env.set(vault.env)
          // As the stock bootstrap clones a conversation's source.
          await handle.git.clone({
            url: originUrlWithoutCredentials(revision.remote.url),
            ref: revision.defaultBranch,
            auth: { token: "" },
          })
          if (!(await handle.fs.exists("/workspace/.git")))
            throw new Error("The pool clone made no repository")
        } finally {
          // The session waits with no proxy session: no egress, no credential.
          await vault.close()
        }
        await persistSandboxInstance(
          { ...row, state: "live", lastHeartbeatAt: new Date() },
          ownershipOf(row),
        )
        return "filled" as const
      } catch (error) {
        await handle?.destroy().catch((stopError: unknown) =>
          log.warn({
            step: "chat-sandbox-pool",
            message: `Stopping a pool session whose fill failed failed: ${String(stopError)}`,
            sandboxId: id,
          }),
        )
        await deleteSandboxInstance(id, orgId, ownershipOf(row))
        throw error
      }
    },
  )
  log.info({
    step: "sandbox-lifecycle",
    phase: "pool-fill",
    message: `sandbox lifecycle pool-fill ${Date.now() - started}ms`,
    outcome,
    workspaceId,
    ms: Date.now() - started,
  })
  return outcome
}

/** Start a fill in the background; a failure is logged and never fails a chat. */
export function requestChatSandboxPoolFill(
  input: Parameters<typeof fillChatSandboxPool>[0],
): void {
  void fillChatSandboxPool(input).catch((error: unknown) =>
    log.warn({
      step: "chat-sandbox-pool",
      message: `Filling the chat sandbox pool failed: ${String(error)}`,
      workspaceId: input.workspaceId,
    }),
  )
}
