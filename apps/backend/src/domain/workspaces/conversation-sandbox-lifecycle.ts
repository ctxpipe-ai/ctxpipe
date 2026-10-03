import type {
  SandboxHandle,
  SandboxProvider as TanstackSandboxProvider,
} from "@tanstack/ai-sandbox"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { listOrgConversationsForSandboxGc } from "../../models/conversations.js"
import {
  countRunningSandboxes,
  deleteSandboxInstance,
  getSandboxInstance,
  isRunningSandboxProvider,
  listSandboxInstances,
  ownershipOf,
  persistSandboxInstance,
  type RunningSandboxProvider,
  SandboxInstanceOwnershipConflict,
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
import {
  collectUnusedWorkspaceChatBases,
  destroyUnusedSandbox,
} from "./workspace-sandbox-cleanup.js"

/**
 * Retries (a turn holds the conversation, a stop or delete failed) land on
 * the next 5-minute boundary, so every run that retries within the same
 * window schedules the same next run. Five minutes also stays inside the
 * PR worker's 10-minute idle window.
 */
const RETRY_GRID_MS = 5 * 60_000

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

/**
 * Every start of a conversation sandbox (a create, or the resume of a stopped
 * one) takes one of the organization's running slots, counted from our
 * sandbox table under an org-wide lock. A create reserves its row before the
 * provider call, so concurrent starts in other Workspaces see it, and gives
 * the slot back at once if the create or its setup fails.
 */
export function withConversationSandboxSlots(
  provider: TanstackSandboxProvider,
  owner: {
    orgId: string
    workspaceId: string
    conversationId: string
    provider: RunningSandboxProvider
    image: string
    revision: WorkspaceRevision
  },
): TanstackSandboxProvider {
  const { orgId } = owner
  const underSlots = <T>(fn: () => Promise<T>) =>
    postgresSandboxLocks(orgId).withLock("org-sandbox-slots", fn)
  const assertSlotFree = async (key: string) => {
    if ((await countRunningSandboxes(orgId, key)) >= ORG_RUNNING_SANDBOX_LIMIT)
      throw new SandboxCapacityError()
  }
  /** Drop a reservation whose create never finished; a finished one is kept. */
  const release = async (key: string) => {
    try {
      await deleteSandboxInstance(key, orgId, {
        kind: "chat",
        workspaceId: owner.workspaceId,
        conversationId: owner.conversationId,
        provider: owner.provider,
        providerSandboxId: null,
        image: owner.image,
        revision: owner.revision,
      })
    } catch (error) {
      if (!(error instanceof SandboxInstanceOwnershipConflict)) throw error
    }
  }
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    async create(input) {
      // Stock `ensure` always passes the sandbox key as the create id.
      const key = input.id
      if (!key) throw new Error("Conversation sandbox create needs its key")
      await underSlots(async () => {
        const existing = await getSandboxInstance(key, orgId)
        await assertSlotFree(key)
        await persistSandboxInstance(
          {
            id: key,
            kind: "chat",
            orgId,
            workspaceId: owner.workspaceId,
            conversationId: owner.conversationId,
            provider: owner.provider,
            providerSandboxId: null,
            image: owner.image,
            revision: owner.revision,
            state: "live",
            lastHeartbeatAt: new Date(),
          },
          existing ? ownershipOf(existing) : undefined,
        )
      })
      let created: SandboxHandle
      try {
        created = await provider.create(input)
      } catch (error) {
        await release(key)
        throw error
      }
      // Stock ensure destroys the handle when setup fails or is aborted.
      const { snapshot, fork } = created
      return {
        ...created,
        // Docker keeps these on its prototype; spread drops them.
        ...(snapshot
          ? { snapshot: (label?: string) => snapshot.call(created, label) }
          : {}),
        ...(fork ? { fork: () => fork.call(created) } : {}),
        destroy: async () => {
          await created.destroy()
          await release(key)
        },
      }
    },
    async resume(input) {
      const listed = (
        await withOrgDbContext(orgId, () =>
          listSandboxInstances({
            conversationId: owner.conversationId,
            kind: "chat",
          }),
        )
      ).find((row) => row.providerSandboxId === input.id)
      if (listed?.state !== "stopped") return provider.resume(input)
      const claimed = await underSlots(async () => {
        const row = await getSandboxInstance(listed.id, orgId)
        // Deleted since it was listed: start a fresh sandbox instead.
        if (!row || row.providerSandboxId !== input.id) return false
        if (row.state !== "stopped") return true
        await assertSlotFree(row.id)
        await persistSandboxInstance(
          { ...row, state: "live", lastHeartbeatAt: new Date() },
          ownershipOf(row),
        )
        return true
      })
      return claimed ? provider.resume(input) : null
    },
    destroy: (input) => provider.destroy(input),
    ...(provider.restoreSnapshot
      ? { restoreSnapshot: provider.restoreSnapshot.bind(provider) }
      : {}),
  }
}

/**
 * Stop one live sandbox and keep its files; `idleSince` leaves it running if
 * it was used after that. A reservation whose create never finished has no
 * provider sandbox, so its row is removed instead. The caller holds the
 * conversation's lock, which turns and file reads also hold, so nothing is
 * using the sandbox.
 */
async function stopSandboxRow(
  orgId: string,
  id: string,
  idleSince?: Date,
): Promise<boolean> {
  return postgresSandboxLocks(orgId).withLock(`sandbox:${id}`, async () => {
    const row = await getSandboxInstance(id, orgId)
    if (!row || row.state !== "live" || !isRunningSandboxProvider(row.provider))
      return false
    if (idleSince && row.lastHeartbeatAt > idleSince) return false
    if (!row.providerSandboxId) {
      await deleteSandboxInstance(id, orgId, ownershipOf(row))
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
 * Stop a conversation's running sandboxes now, when a run nobody watches
 * (MCP, API callers) ends, so it never holds a slot while idle. If another
 * turn holds the conversation, its end schedules the idle sweep instead. A
 * failure is logged; the sweep that run's turn end scheduled stops it.
 */
export async function stopConversationSandboxes(input: {
  orgId: string
  conversationId: string
}): Promise<void> {
  try {
    await withSandboxLockIfFree(
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
        for (const row of rows.filter((item) =>
          isRunningSandboxProvider(item.provider),
        ))
          await stopSandboxRow(input.orgId, row.id)
      },
    )
  } catch (error) {
    log.error({
      step: "conversation-sandbox-stop",
      message: `Stopping the sandbox after an unattended run failed: ${String(error)}`,
      conversationId: input.conversationId,
    })
  }
}

/** Pass a run's chunks through, then stop its sandboxes however it ends. */
export async function* stoppingSandboxWhenDone<T>(
  target: { orgId: string; conversationId: string },
  stream: AsyncIterable<T>,
): AsyncGenerator<T> {
  try {
    yield* stream
  } finally {
    await stopConversationSandboxes(target)
  }
}

/**
 * Orgs whose sandbox rows need a sweep: any with a conversation sandbox past
 * 30 days or a failed delete (their chain may have ended), and with
 * `includeRunning` also any running a sandbox or holding a Workspace base.
 * The worker-start backstop schedules all of them; the Docker host prune
 * sweeps the dormant ones.
 */
export async function orgsNeedingSweep(input: {
  now: Date
  includeRunning: boolean
}): Promise<string[]> {
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
  const due: string[] = []
  for (const { id } of orgs) {
    try {
      const rows = await withOrgDbContext(id, () => listSandboxInstances({}))
      const expired = rows.some(
        (row) =>
          row.kind === "chat" &&
          (row.state === "destroy_failed" ||
            input.now.getTime() - row.lastHeartbeatAt.getTime() >=
              CHAT_SANDBOX_RETENTION_MS),
      )
      const active =
        input.includeRunning &&
        rows.some(
          (row) =>
            row.kind === "base" ||
            (row.state === "live" && isRunningSandboxProvider(row.provider)),
        )
      if (expired || active) due.push(id)
    } catch (error) {
      log.error({
        step: "conversation-sandbox-sweep-backstop",
        message: `Reading an org's sandboxes failed: ${String(error)}`,
        orgId: id,
      })
    }
  }
  return due
}

/**
 * The lifecycle sweep for one organization's conversation sandboxes:
 * - stop a running sandbox after 5 minutes unused (never while a turn or file
 *   read holds the conversation);
 * - delete a sandbox and its saved state 30 days after its last use, when its
 *   conversation is gone, or when an earlier delete failed.
 * Returns when the next sweep is due, or null when nothing is running and
 * nothing needs a retry. Stopped sandboxes schedule nothing: whichever sweep
 * passes after 30 days deletes them.
 */
export async function sweepConversationSandboxes(
  orgId: string,
  now: Date = new Date(),
): Promise<{ stopped: number; deleted: number; nextSweepAt: Date | null }> {
  const { rows, bases, conversations } = await withOrgDbContext(
    orgId,
    async () => ({
      rows: await listSandboxInstances({ kind: "chat" }),
      bases: await listSandboxInstances({ kind: "base" }),
      conversations: new Set(
        (await listOrgConversationsForSandboxGc(orgId)).map((row) => row.id),
      ),
    }),
  )
  let stopped = 0
  let deleted = 0
  let next: number | null = null
  const dueAt = (at: number) => {
    next = next === null ? at : Math.min(next, at)
  }
  const retryAt =
    Math.floor(now.getTime() / RETRY_GRID_MS) * RETRY_GRID_MS + RETRY_GRID_MS
  const idleSince = new Date(now.getTime() - CHAT_SANDBOX_IDLE_STOP_MS)
  for (const row of rows) {
    const conversationId = row.conversationId
    // Workspace bases have no conversation; base cleanup owns them.
    if (!conversationId) continue
    const expired =
      row.state === "destroy_failed" ||
      !conversations.has(conversationId) ||
      now.getTime() - row.lastHeartbeatAt.getTime() >= CHAT_SANDBOX_RETENTION_MS
    const running =
      row.state === "live" && isRunningSandboxProvider(row.provider)
    if (!expired && !running) continue
    if (!expired && row.lastHeartbeatAt > idleSince) {
      dueAt(row.lastHeartbeatAt.getTime() + CHAT_SANDBOX_IDLE_STOP_MS)
      continue
    }
    try {
      const outcome = await withSandboxLockIfFree(
        orgId,
        `chat-thread:${conversationId}`,
        async () =>
          expired
            ? destroyUnusedSandbox(row.id, orgId, row.lastHeartbeatAt)
            : (await stopSandboxRow(orgId, row.id, idleSince))
              ? "stopped"
              : "used",
      )
      const result = outcome.busy ? "busy" : outcome.value
      if (result === "stopped") stopped += 1
      else if (result === "destroyed") deleted += 1
      // Busy, used since it was listed, or failed: look again soon.
      else dueAt(retryAt)
    } catch (error) {
      log.error({
        step: "conversation-sandbox-sweep",
        message: `Sandbox lifecycle step failed: ${String(error)}`,
        sandboxId: row.id,
      })
      dueAt(retryAt)
    }
  }
  // Bases whose conversations are gone (deleted above, or long ago) go too.
  for (const workspaceId of new Set(bases.map((row) => row.workspaceId))) {
    try {
      await collectUnusedWorkspaceChatBases(orgId, workspaceId, now)
    } catch (error) {
      log.error({
        step: "conversation-sandbox-sweep",
        message: `Deleting unused Workspace bases failed: ${String(error)}`,
        workspaceId,
      })
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
