import { randomUUID } from "node:crypto"

import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"

import { withOrgDbContext } from "../../db/client.js"
import {
  claimPoolSession,
  deleteSandboxInstance,
  getDesiredWorkspaceRevision,
  listSandboxInstances,
  ownershipOf,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import type { RunVault } from "./agent-vault.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import { warmOpencode } from "./opencode-warmup.js"
import { sameWorkspaceBinding, type WorkspaceRevision } from "./revision.js"
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

/**
 * Claim a ready pool session of the Workspace on `create`, or create a new
 * session when none is ready. The claimed session's marker check (`resume`)
 * also tells a session that AgentCore stopped from one that runs: a stopped
 * one, or a check that fails, gives a cold create.
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
      let handle: SandboxHandle | null = null
      if (sessionId) {
        try {
          handle = await provider.resume({ id: sessionId })
        } catch (error) {
          // The claim deleted the row: nothing else stops this session
          // before AgentCore's idle stop.
          await provider
            .destroy({ id: sessionId })
            .catch((stopError: unknown) =>
              log.warn({
                step: "chat-sandbox-pool",
                message: `Could not stop a claimed pool session whose check failed (${String(error)}): ${String(stopError)}`,
                sessionId,
              }),
            )
        }
      }
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

/**
 * When the sweep stops a pool session: at the end of its wait, or 30
 * minutes after its fill started (a fill that has not finished is lost).
 */
export function poolRowDueAt(row: SandboxInstanceRecord): number {
  const at = row.lastHeartbeatAt.getTime()
  if (row.state === "live") return at + POOL_SESSION_TTL_MS
  if (row.state === "building") return at + 30 * 60_000
  return at
}

/**
 * Fill one pool session for the Workspace. It makes none (`full`) when the
 * Workspace has a pool session or the organization has three, and none
 * (`stale`) when the Workspace no longer has this repository binding. Each
 * pool row counts until the sweep stops its session, also after its wait.
 */
export async function fillChatSandboxPool(input: {
  orgId: string
  workspaceId: string
  revision: WorkspaceRevision
  /** The provider of a pool session, which trusts the vault's CA. */
  provider: (caPem: string | undefined) => SandboxProvider
  /** The fill's own vault, GitHub read rules only, by its run key. */
  openVault: (runKey: string) => Promise<RunVault>
}): Promise<"filled" | "full" | "stale"> {
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
    // The key value of the AgentCore chat sandboxes.
    image: "agentcore-agent",
    revision,
    state: "building",
    lastHeartbeatAt: new Date(),
  }
  /**
   * Reserve the row under the Workspace lock, which a Workspace delete or
   * relink holds while it lists the sandboxes: the cleanup either finds the
   * row, or comes first and the binding check fails.
   */
  const reserve = () =>
    postgresSandboxLocks(orgId).withLock(
      `workspace-sandboxes:${workspaceId}`,
      async () => {
        const desired = await withOrgDbContext(orgId, () =>
          getDesiredWorkspaceRevision(workspaceId, "read", orgId),
        )
        if (!desired || !sameWorkspaceBinding(desired, revision))
          return "stale" as const
        return postgresSandboxLocks(orgId).withLock(
          "chat-sandbox-pool",
          async () => {
            const rows = await withOrgDbContext(orgId, () =>
              listSandboxInstances({ kind: "pool" }),
            )
            if (
              rows.length >= 3 ||
              rows.some((row) => row.workspaceId === workspaceId)
            )
              return "full" as const
            await persistSandboxInstance(reserved)
            return "reserved" as const
          },
        )
      },
    )
  let outcome: "filled" | "full" | "stale" | "failed" = "failed"
  try {
    // The row's own lock is taken before the row exists: a cleanup that
    // finds the row waits for the fill, then stops the session.
    outcome = await postgresSandboxLocks(orgId).withLock(
      `sandbox:${id}`,
      async () => {
        const reservation = await reserve()
        if (reservation !== "reserved") return reservation
        let row: SandboxInstanceRecord = reserved
        let handle: SandboxHandle | undefined
        let warmup: Promise<void> | undefined
        try {
          const vault = await input.openVault(id)
          try {
            handle = await input.provider(vault.caPem).create({ id })
            // Before the vault env: the warm-up holds no proxy session.
            warmup = warmOpencode(handle)
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
            // The session waits with no proxy session: no egress, no
            // credential.
            await vault.close()
          }
          // A claim finds OpenCode's files in memory (`opencode-warmup.ts`).
          await warmup
          await persistSandboxInstance(
            { ...row, state: "live", lastHeartbeatAt: new Date() },
            ownershipOf(row),
          )
          return "filled" as const
        } catch (error) {
          try {
            await handle?.destroy()
            await deleteSandboxInstance(id, orgId, ownershipOf(row))
          } catch (stopError) {
            // The row stays, so the session still counts and the sweep stops it.
            log.warn({
              step: "chat-sandbox-pool",
              message: `Could not stop the session of a failed pool fill: ${String(stopError)}`,
              sandboxId: id,
            })
            await persistSandboxInstance(
              { ...row, state: "destroy_failed" },
              ownershipOf(row),
            )
          }
          throw error
        }
      },
    )
    return outcome
  } finally {
    // The event also names the conversation whose ready sandbox started it.
    markSandboxLifecycle("pool-fill", {
      outcome,
      workspaceId,
      ms: Date.now() - started,
    })
  }
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
