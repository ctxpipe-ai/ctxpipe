import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import {
  getSandboxInstance,
  listSandboxInstances,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  shouldDestroyChatSandbox,
  shouldDestroyJobSandbox,
} from "./chat-lifecycle.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { destroyDetachedProviderSandbox } from "./sandbox-provider.js"

/** Destroy the exact persisted provider identity under the same native key lock as ensure. */
export async function destroyWorkspaceSandbox(
  id: string,
  orgId?: string | null,
): Promise<boolean> {
  assertNotInOrgDbContext()
  const initial = await getSandboxInstance(id, orgId)
  if (!initial) return true
  return postgresSandboxLocks(initial.orgId).withLock(
    `sandbox:${id}`,
    async (signal) => {
      const stored = await getSandboxInstance(id, initial.orgId)
      if (!stored) return true
      signal.throwIfAborted()
      try {
        if (stored.providerSandboxId)
          await destroyDetachedProviderSandbox({
            provider: stored.provider,
            providerSandboxId: stored.providerSandboxId,
          })
      } catch (error) {
        signal.throwIfAborted()
        await persistSandboxInstance({ ...stored, state: "destroy_failed" })
        log.error({
          step: "destroy-native-workspace-sandbox",
          sandboxId: id,
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      }
      signal.throwIfAborted()
      await postgresSandboxInstanceStore({
        orgId: stored.orgId,
        workspaceId: stored.workspaceId,
      }).delete(id)
      return true
    },
  )
}

async function destroyRows(
  rows: SandboxInstanceRecord[],
  failClosed = false,
): Promise<number> {
  let destroyed = 0
  for (const row of rows) {
    if (await destroyWorkspaceSandbox(row.id, row.orgId)) destroyed += 1
    else if (failClosed)
      throw new Error(`Sandbox ${row.id} could not be destroyed`)
  }
  return destroyed
}

export async function destroySandboxesForConversation(
  conversationId: string,
): Promise<number> {
  return destroyRows(
    await listSandboxInstances({ conversationId, kind: "chat" }),
  )
}

export async function withDestroyedConversationSandboxes<T>(
  input: { conversationId: string; orgId: string; workspaceId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({
      conversationId: input.conversationId,
      kind: "chat",
    }),
  )
  await destroyRows(rows, true)
  return withOrgDbContext(input.orgId, fn)
}

export async function destroySandboxesForWorkspace(
  workspaceId: string,
  kind: "chat" | "job" | "any" = "any",
): Promise<number> {
  return destroyRows(
    await listSandboxInstances({
      workspaceId,
      kind: kind === "any" ? undefined : kind,
    }),
  )
}

export async function withDestroyedWorkspaceSandboxes<T>(
  input: { workspaceId: string; orgId: string },
  fn: (remaining: SandboxInstanceRecord[]) => Promise<T>,
): Promise<T> {
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({ workspaceId: input.workspaceId }),
  )
  await destroyRows(rows, true)
  return withOrgDbContext(input.orgId, async () =>
    fn(await listSandboxInstances({ workspaceId: input.workspaceId })),
  )
}

export function chatSandboxesDueForDestroy(input: {
  conversations: ReadonlyArray<{
    id: string
    lastMessageAt: Date | null
  }>
  now: Date
}): string[] {
  return input.conversations
    .filter((row) =>
      shouldDestroyChatSandbox({
        conversationDeleted: false,
        lastTurnAt: row.lastMessageAt,
        now: input.now,
      }),
    )
    .map((row) => row.id)
}

export function jobSandboxesDueForDestroy(input: {
  workspaces: ReadonlyArray<{
    id: string
    lastJobAt: Date | null
    desiredUrlChanged?: boolean
    runningOrQueued?: boolean
  }>
  now: Date
}): string[] {
  return input.workspaces
    .filter((row) =>
      shouldDestroyJobSandbox({
        desiredUrlChanged: row.desiredUrlChanged ?? false,
        runningOrQueued: row.runningOrQueued ?? false,
        lastJobAt: row.lastJobAt,
        now: input.now,
      }),
    )
    .map((row) => row.id)
}
