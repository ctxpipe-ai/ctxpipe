import type { SandboxProvider as TanstackSandboxProvider } from "@tanstack/ai-sandbox"
import { withOrgDbContext } from "../../db/client.js"
import { listOrgConversationsForSandboxGc } from "../../models/conversations.js"
import {
  countRunningConversationSandboxes,
  deleteSandboxInstance,
  getSandboxInstance,
  listSandboxInstances,
  persistSandboxInstance,
  type SandboxInstanceOwnership,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  CHAT_SANDBOX_IDLE_STOP_MS,
  CHAT_SANDBOX_RETENTION_MS,
  ORG_RUNNING_SANDBOX_LIMIT,
} from "./chat-lifecycle.js"
import type { WorkspaceRevision } from "./revision.js"
import {
  postgresSandboxLocks,
  withSandboxLockIfFree,
} from "./sandbox-lock-store.js"
import { stopDetachedProviderSandbox } from "./sandbox-provider.js"
import { destroyWorkspaceSandbox } from "./workspace-sandbox-cleanup.js"

/** Providers whose sandboxes keep running between turns, so they can be stopped. */
type RunningProvider = "docker" | "vercel"

function isRunningProvider(
  provider: string | null | undefined,
): provider is RunningProvider {
  return provider === "docker" || provider === "vercel"
}

/** A busy conversation is checked again a minute later. */
const BUSY_RETRY_MS = 60_000
/** A failed stop or delete is retried later rather than every minute. */
const FAILURE_RETRY_MS = 15 * 60_000

export class SandboxCapacityError extends Error {
  /** Carried into the chat stream's RUN_ERROR, so clients can tell it apart. */
  readonly code = "sandbox_capacity"
  constructor() {
    super(
      `Workspace chat is at capacity: your organization already has ${ORG_RUNNING_SANDBOX_LIMIT} chats running. Try again in a few minutes, after an idle chat stops.`,
    )
    this.name = "SandboxCapacityError"
  }
}

function ownershipOf(row: SandboxInstanceRecord): SandboxInstanceOwnership {
  return {
    kind: row.kind,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    provider: row.provider,
    image: row.image,
    revision: row.revision,
  }
}

/**
 * Every start of a conversation sandbox (a create, or the resume of a stopped
 * one) takes one of the organization's running slots, counted from our
 * sandbox table under an org-wide lock. A create reserves its row before the
 * provider call, so concurrent starts in other Workspaces see it. Each start
 * also schedules the sweep that stops the sandbox once it is idle.
 */
export function withConversationSandboxSlots(
  provider: TanstackSandboxProvider,
  owner: {
    orgId: string
    workspaceId: string
    conversationId: string
    provider: RunningProvider
    image: string
    revision: WorkspaceRevision
  },
): TanstackSandboxProvider {
  const claim = async (key: string, existing: SandboxInstanceRecord | null) => {
    await postgresSandboxLocks(owner.orgId).withLock(
      "org-sandbox-slots",
      async () => {
        const running = await countRunningConversationSandboxes(
          owner.orgId,
          key,
        )
        if (running >= ORG_RUNNING_SANDBOX_LIMIT)
          throw new SandboxCapacityError()
        const now = new Date()
        await persistSandboxInstance(
          existing
            ? { ...existing, state: "live", lastHeartbeatAt: now }
            : {
                id: key,
                kind: "chat",
                orgId: owner.orgId,
                workspaceId: owner.workspaceId,
                conversationId: owner.conversationId,
                provider: owner.provider,
                providerSandboxId: null,
                image: owner.image,
                revision: owner.revision,
                state: "live",
                lastHeartbeatAt: now,
              },
          existing ? ownershipOf(existing) : undefined,
        )
      },
    )
    await scheduleSweep(
      owner.orgId,
      new Date(Date.now() + CHAT_SANDBOX_IDLE_STOP_MS),
    )
  }
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    async create(input) {
      // Stock `ensure` always passes the sandbox key as the create id.
      if (!input.id)
        throw new Error("Conversation sandbox create needs its key")
      await claim(input.id, await getSandboxInstance(input.id, owner.orgId))
      return provider.create(input)
    },
    async resume(input) {
      const rows = await withOrgDbContext(owner.orgId, () =>
        listSandboxInstances({
          conversationId: owner.conversationId,
          kind: "chat",
        }),
      )
      const row = rows.find((item) => item.providerSandboxId === input.id)
      if (row?.state === "stopped") await claim(row.id, row)
      return provider.resume(input)
    },
    destroy: (input) => provider.destroy(input),
    ...(provider.restoreSnapshot
      ? { restoreSnapshot: provider.restoreSnapshot.bind(provider) }
      : {}),
  }
}

async function scheduleSweep(orgId: string, at: Date): Promise<void> {
  try {
    const { scheduleConversationSandboxSweep } = await import(
      "../../openworkflow/workflows/conversation-sandbox-sweep.js"
    )
    await scheduleConversationSandboxSweep(orgId, at)
  } catch (error) {
    // The turn goes on; the sweep after the next start or tip check stops it.
    log.error({
      step: "conversation-sandbox-sweep-schedule",
      message: `Scheduling the sandbox sweep failed: ${String(error)}`,
      orgId,
    })
  }
}

/**
 * Stop one live sandbox and keep its files; `idleSince` leaves it running if
 * it was used after that. A reservation whose create never finished has no
 * provider sandbox, so its row is removed instead. The caller holds the
 * conversation's lock, so no turn is using the sandbox.
 */
async function stopSandboxRow(
  orgId: string,
  id: string,
  idleSince?: Date,
): Promise<boolean> {
  return postgresSandboxLocks(orgId).withLock(`sandbox:${id}`, async () => {
    const row = await getSandboxInstance(id, orgId)
    if (!row || row.state !== "live" || !isRunningProvider(row.provider))
      return false
    if (idleSince && row.lastHeartbeatAt > idleSince) return false
    if (!row.providerSandboxId) {
      await deleteSandboxInstance(id, orgId, {
        ...ownershipOf(row),
        providerSandboxId: null,
      })
      return true
    }
    await stopDetachedProviderSandbox({
      orgId,
      provider: row.provider,
      providerSandboxId: row.providerSandboxId,
    })
    await persistSandboxInstance({ ...row, state: "stopped" }, ownershipOf(row))
    return true
  })
}

/**
 * Stop a conversation's running sandboxes as soon as a run nobody watches
 * (an MCP turn) ends. If another turn already holds the conversation, its
 * sandbox stays up; that turn's end or the idle sweep stops it.
 */
export async function stopConversationSandboxes(input: {
  orgId: string
  conversationId: string
}): Promise<{ stopped: number } | { busy: true }> {
  const outcome = await withSandboxLockIfFree(
    input.orgId,
    `chat-thread:${input.conversationId}`,
    async () => {
      const rows = await withOrgDbContext(input.orgId, () =>
        listSandboxInstances({
          conversationId: input.conversationId,
          kind: "chat",
          state: "live",
        }),
      )
      let stopped = 0
      for (const row of rows) {
        try {
          if (await stopSandboxRow(input.orgId, row.id)) stopped += 1
        } catch (error) {
          log.error({
            step: "conversation-sandbox-stop",
            message: `Stopping a conversation sandbox failed: ${String(error)}`,
            sandboxId: row.id,
          })
        }
      }
      return stopped
    },
  )
  return outcome.busy ? outcome : { stopped: outcome.value }
}

/**
 * The lifecycle sweep for one organization's conversation sandboxes:
 * - stop a running sandbox after 5 minutes unused (never while a turn holds
 *   the conversation);
 * - delete a sandbox and its saved state 30 days after its last use, when its
 *   conversation is gone, or when an earlier delete failed.
 * Returns when the sweep is next due, or null when no sandbox is left.
 */
export async function sweepConversationSandboxes(
  orgId: string,
  now: Date = new Date(),
): Promise<{ stopped: number; deleted: number; nextSweepAt: Date | null }> {
  const { rows, conversations } = await withOrgDbContext(orgId, async () => ({
    rows: await listSandboxInstances({ kind: "chat" }),
    conversations: new Set(
      (await listOrgConversationsForSandboxGc(orgId)).map((row) => row.id),
    ),
  }))
  let stopped = 0
  let deleted = 0
  let next: number | null = null
  const dueAt = (at: number) => {
    next = next === null ? at : Math.min(next, at)
  }
  const idleSince = new Date(now.getTime() - CHAT_SANDBOX_IDLE_STOP_MS)
  for (const row of rows) {
    const conversationId = row.conversationId
    // Workspace bases have no conversation; base cleanup owns them.
    if (!conversationId) continue
    const lastUse = row.lastHeartbeatAt.getTime()
    const expired =
      row.state === "destroy_failed" ||
      !conversations.has(conversationId) ||
      now.getTime() - lastUse >= CHAT_SANDBOX_RETENTION_MS
    const idle =
      row.state === "live" &&
      isRunningProvider(row.provider) &&
      row.lastHeartbeatAt <= idleSince
    if (!expired && !idle) {
      dueAt(
        row.state === "live" && isRunningProvider(row.provider)
          ? lastUse + CHAT_SANDBOX_IDLE_STOP_MS
          : lastUse + CHAT_SANDBOX_RETENTION_MS,
      )
      continue
    }
    try {
      const outcome = await withSandboxLockIfFree(
        orgId,
        `chat-thread:${conversationId}`,
        async (): Promise<"stopped" | "deleted" | "used" | "failed"> => {
          if (!expired)
            return (await stopSandboxRow(orgId, row.id, idleSince))
              ? "stopped"
              : "used"
          // Something may have resumed it since it was listed.
          const current = await getSandboxInstance(row.id, orgId)
          if (current && current.lastHeartbeatAt.getTime() !== lastUse)
            return "used"
          return (await destroyWorkspaceSandbox(row.id, orgId))
            ? "deleted"
            : "failed"
        },
      )
      const result = outcome.busy ? "busy" : outcome.value
      if (result === "stopped") {
        stopped += 1
        dueAt(lastUse + CHAT_SANDBOX_RETENTION_MS)
      } else if (result === "deleted") deleted += 1
      else if (result === "failed") dueAt(now.getTime() + FAILURE_RETRY_MS)
      // Busy (a turn holds it) or used since it was listed: look again soon.
      else dueAt(now.getTime() + BUSY_RETRY_MS)
    } catch (error) {
      log.error({
        step: "conversation-sandbox-sweep",
        message: `Sandbox lifecycle step failed: ${String(error)}`,
        sandboxId: row.id,
      })
      dueAt(now.getTime() + FAILURE_RETRY_MS)
    }
  }
  if (stopped || deleted)
    log.info({
      step: "conversation-sandbox-sweep",
      message: `Stopped ${stopped} idle and deleted ${deleted} expired conversation sandboxes`,
      orgId,
      stopped,
      deleted,
    })
  return {
    stopped,
    deleted,
    nextSweepAt: next === null ? null : new Date(next),
  }
}
