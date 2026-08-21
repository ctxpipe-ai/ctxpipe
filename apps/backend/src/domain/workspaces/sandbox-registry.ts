import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxInstance,
  heartbeatSandboxInstance,
  listSandboxInstances,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  shouldDestroyChatSandbox,
  shouldDestroyJobSandbox,
} from "./chat-lifecycle.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { destroyDetachedProviderSandbox } from "./sandbox-provider.js"

export type RegisteredSandbox = {
  id: string
  kind: "chat" | "job"
  workspaceId: string
  conversationId?: string
  orgId?: string
  desiredUrl?: string
  desiredGeneration?: number
  desiredSha?: string | null
  defaultBranch?: string
  lastHeartbeatAt: Date
  provider?: string
  providerSandboxId?: string
  latestSnapshotId?: string
  latestRunId?: string
  destroy?: () => Promise<void>
  handle?: JobSandboxHandle
}

const sandboxes = new Map<string, RegisteredSandbox>()

function toInstanceRecord(
  sandbox: RegisteredSandbox,
  state: SandboxInstanceRecord["state"],
): SandboxInstanceRecord {
  if (!sandbox.orgId) throw new Error("sandbox orgId is required")
  return {
    id: sandbox.id,
    kind: sandbox.kind,
    orgId: sandbox.orgId,
    workspaceId: sandbox.workspaceId,
    conversationId: sandbox.conversationId ?? null,
    desiredUrl: sandbox.desiredUrl ?? null,
    desiredGeneration: sandbox.desiredGeneration ?? null,
    desiredSha: sandbox.desiredSha ?? null,
    provider: sandbox.provider ?? null,
    providerSandboxId: sandbox.providerSandboxId ?? null,
    latestSnapshotId: sandbox.latestSnapshotId ?? null,
    latestRunId: sandbox.latestRunId ?? null,
    state,
    lastHeartbeatAt: sandbox.lastHeartbeatAt,
  }
}

export function attachWorkspaceSandbox(
  sandbox: Omit<RegisteredSandbox, "lastHeartbeatAt"> & {
    lastHeartbeatAt?: Date
  },
): RegisteredSandbox {
  const existing = sandboxes.get(sandbox.id)
  const next: RegisteredSandbox = {
    ...existing,
    ...sandbox,
    handle: sandbox.handle ?? existing?.handle,
    destroy: sandbox.destroy ?? existing?.destroy,
    lastHeartbeatAt:
      sandbox.lastHeartbeatAt ?? existing?.lastHeartbeatAt ?? new Date(),
  }
  sandboxes.set(next.id, next)
  return next
}

export async function attachChatSandboxHandle(
  sandbox: Omit<RegisteredSandbox, "id" | "lastHeartbeatAt"> & {
    conversationId: string
    lastHeartbeatAt?: Date
  },
): Promise<RegisteredSandbox> {
  const listChat = () =>
    listSandboxInstances({
      conversationId: sandbox.conversationId,
      kind: "chat",
    })
  const rows = await (sandbox.orgId
    ? withOrgDbContext(sandbox.orgId, listChat)
    : listChat()
  ).catch((error) => {
    logSandboxError("list-sandbox-instances", sandbox.conversationId, error)
    return [] as SandboxInstanceRecord[]
  })
  const canonical = rows.find((row) => row.providerSandboxId) ?? rows[0]
  return attachWorkspaceSandbox({
    ...sandbox,
    id: canonical?.id ?? sandbox.conversationId,
    orgId: sandbox.orgId ?? canonical?.orgId ?? undefined,
    provider: canonical?.provider ?? undefined,
    providerSandboxId: canonical?.providerSandboxId ?? undefined,
    latestSnapshotId: canonical?.latestSnapshotId ?? undefined,
    latestRunId: canonical?.latestRunId ?? undefined,
  })
}

export async function registerWorkspaceSandbox(
  sandbox: Omit<RegisteredSandbox, "lastHeartbeatAt"> & {
    lastHeartbeatAt?: Date
  },
): Promise<RegisteredSandbox> {
  const next = attachWorkspaceSandbox(sandbox)
  const claimed = await claimSandboxInstance(toInstanceRecord(next, "live"))
  const canonical: RegisteredSandbox = {
    ...next,
    id: claimed.record.id,
    lastHeartbeatAt: claimed.record.lastHeartbeatAt,
    provider: next.provider ?? claimed.record.provider ?? undefined,
    providerSandboxId:
      next.providerSandboxId ?? claimed.record.providerSandboxId ?? undefined,
    latestSnapshotId:
      next.latestSnapshotId ?? claimed.record.latestSnapshotId ?? undefined,
    latestRunId: next.latestRunId ?? claimed.record.latestRunId ?? undefined,
  }
  if (next.id !== canonical.id) sandboxes.delete(next.id)
  sandboxes.set(canonical.id, canonical)
  await persistSandboxInstance(toInstanceRecord(canonical, "live"))
  return canonical
}

function logSandboxError(
  step: string,
  sandboxId: string,
  error: unknown,
): void {
  log.error({
    step,
    sandboxId,
    error: error instanceof Error ? error.message : String(error),
  })
}

export function heartbeatWorkspaceSandbox(id: string, now = new Date()): void {
  const existing = sandboxes.get(id)
  if (existing) {
    sandboxes.set(id, { ...existing, lastHeartbeatAt: now })
  }
  persistHeartbeatQuietly(id, now, existing?.orgId)
}

export function heartbeatChatSandboxes(
  conversationId: string,
  now = new Date(),
): void {
  const attached = getRegisteredChatSandbox(conversationId)
  if (attached) heartbeatWorkspaceSandbox(attached.id, now)
  const listChat = () => listSandboxInstances({ conversationId, kind: "chat" })
  void (
    attached?.orgId ? withOrgDbContext(attached.orgId, listChat) : listChat()
  )
    .then((rows) => {
      for (const row of rows) {
        if (row.id === attached?.id) continue
        persistHeartbeatQuietly(row.id, now, row.orgId ?? attached?.orgId)
      }
    })
    .catch((error) => {
      logSandboxError("list-sandbox-instances", conversationId, error)
    })
}

function persistHeartbeatQuietly(
  id: string,
  now: Date,
  orgId?: string | null,
): void {
  try {
    void heartbeatSandboxInstance(id, now, orgId).catch((error) => {
      logSandboxError("heartbeat-sandbox-instance", id, error)
    })
  } catch (error) {
    logSandboxError("heartbeat-sandbox-instance", id, error)
  }
}

export async function destroySandboxesForConversation(
  conversationId: string,
): Promise<number> {
  return destroyListedSandboxesForConversation(conversationId)
}

export async function withDestroyedConversationSandboxes<T>(
  input: { conversationId: string; orgId: string; workspaceId: string },
  fn: () => Promise<T>,
): Promise<T> {
  await destroyListedSandboxesForConversation(input.conversationId, {
    orgId: input.orgId,
    failClosed: true,
  })
  return withOrgDbContext(input.orgId, fn)
}

async function destroyListedSandboxesForConversation(
  conversationId: string,
  options?: { orgId?: string; failClosed?: boolean },
): Promise<number> {
  const list = () =>
    listSandboxInstances({
      conversationId,
      kind: "chat",
    })
  const stored = options?.failClosed
    ? await (options.orgId ? withOrgDbContext(options.orgId, list) : list())
    : await list().catch((error) => {
        logSandboxError("list-sandbox-instances", conversationId, error)
        return [] as SandboxInstanceRecord[]
      })
  const ids = new Set([
    ...[...sandboxes.values()]
      .filter((row) => row.conversationId === conversationId)
      .map((row) => row.id),
    ...stored.map((row) => row.id),
  ])
  let destroyed = 0
  for (const id of ids) {
    if (await destroyWorkspaceSandbox(id)) destroyed += 1
  }
  return destroyed
}

export async function destroySandboxesForWorkspace(
  workspaceId: string,
  kind: "chat" | "job" | "any" = "any",
): Promise<number> {
  return destroyListedSandboxesForWorkspace(workspaceId, kind)
}

export async function withDestroyedWorkspaceSandboxes<T>(
  input: { workspaceId: string; orgId: string },
  fn: (remaining: SandboxInstanceRecord[]) => Promise<T>,
): Promise<T> {
  await destroyListedSandboxesForWorkspace(input.workspaceId, "any", {
    orgId: input.orgId,
    failClosed: true,
  })
  return withOrgDbContext(input.orgId, async () => {
    const remaining = await listSandboxInstances({
      workspaceId: input.workspaceId,
    })
    return fn(remaining)
  })
}

async function destroyListedSandboxesForWorkspace(
  workspaceId: string,
  kind: "chat" | "job" | "any",
  options?: { orgId?: string; failClosed?: boolean },
): Promise<number> {
  const list = () =>
    listSandboxInstances({
      workspaceId,
      kind: kind === "any" ? undefined : kind,
    })
  const stored = options?.failClosed
    ? await (options.orgId ? withOrgDbContext(options.orgId, list) : list())
    : await list().catch((error) => {
        logSandboxError("list-sandbox-instances", workspaceId, error)
        return [] as SandboxInstanceRecord[]
      })
  const ids = new Set([
    ...[...sandboxes.values()]
      .filter(
        (row) =>
          row.workspaceId === workspaceId &&
          (kind === "any" || row.kind === kind),
      )
      .map((row) => row.id),
    ...stored
      .filter((row) => kind === "any" || row.kind === kind)
      .map((row) => row.id),
  ])
  let destroyed = 0
  for (const id of ids) {
    if (await destroyWorkspaceSandbox(id)) destroyed += 1
  }
  return destroyed
}

function findHandleForStored(
  stored: SandboxInstanceRecord | null,
): RegisteredSandbox | undefined {
  if (!stored) return undefined
  const byId = sandboxes.get(stored.id)
  if (byId) return byId
  if (stored.kind === "chat" && stored.conversationId) {
    return getRegisteredChatSandbox(stored.conversationId) ?? undefined
  }
  return [...sandboxes.values()].find(
    (item) =>
      item.kind === stored.kind && item.workspaceId === stored.workspaceId,
  )
}

function destroyFailedRecord(
  handleRow: RegisteredSandbox | undefined,
  stored: SandboxInstanceRecord | null,
): SandboxInstanceRecord | null {
  const base =
    stored ?? (handleRow ? toInstanceRecord(handleRow, "live") : null)
  if (!base) return null
  return {
    ...base,
    orgId: handleRow?.orgId ?? base.orgId ?? null,
    conversationId: handleRow?.conversationId ?? base.conversationId ?? null,
    provider: handleRow?.provider ?? base.provider ?? null,
    providerSandboxId:
      handleRow?.providerSandboxId ?? base.providerSandboxId ?? null,
    latestSnapshotId:
      handleRow?.latestSnapshotId ?? base.latestSnapshotId ?? null,
    latestRunId: handleRow?.latestRunId ?? base.latestRunId ?? null,
    lastHeartbeatAt: handleRow?.lastHeartbeatAt ?? base.lastHeartbeatAt,
    state: "destroy_failed",
  }
}

export async function destroyWorkspaceSandbox(id: string): Promise<boolean> {
  assertNotInOrgDbContext()
  const existing = sandboxes.get(id)
  const stored = await getSandboxInstance(id, existing?.orgId).catch(
    (error) => {
      logSandboxError("get-sandbox-instance", id, error)
      return null
    },
  )
  const handleRow = existing ?? findHandleForStored(stored)
  if (handleRow?.destroy) {
    try {
      await handleRow.destroy()
    } catch (error) {
      logSandboxError("destroy-workspace-sandbox", id, error)
      const failed = destroyFailedRecord(handleRow, stored)
      if (failed) {
        try {
          await persistSandboxInstance(failed)
        } catch (persistError) {
          logSandboxError("persist-sandbox-instance", failed.id, persistError)
        }
      }
      return false
    }
    sandboxes.delete(handleRow.id)
    if (existing && existing.id !== handleRow.id) sandboxes.delete(existing.id)
  } else if (existing) {
    sandboxes.delete(id)
  } else if (stored?.providerSandboxId) {
    try {
      await destroyDetachedProviderSandbox({
        provider: stored.provider,
        providerSandboxId: stored.providerSandboxId,
      })
    } catch (error) {
      logSandboxError("destroy-detached-provider-sandbox", id, error)
      const failed = destroyFailedRecord(undefined, stored)
      if (failed) {
        try {
          await persistSandboxInstance(failed)
        } catch (persistError) {
          logSandboxError("persist-sandbox-instance", failed.id, persistError)
        }
      }
      return false
    }
  }
  try {
    await deleteSandboxInstance(id, existing?.orgId ?? stored?.orgId)
  } catch (error) {
    logSandboxError("delete-sandbox-instance", id, error)
    return handleRow != null || existing != null
  }
  return true
}

export function listRegisteredSandboxes(): RegisteredSandbox[] {
  return [...sandboxes.values()]
}

export function resetRegisteredSandboxes(): void {
  sandboxes.clear()
}

export function getJobSandbox(workspaceId: string): JobSandboxHandle | null {
  const row = [...sandboxes.values()].find(
    (item) =>
      item.kind === "job" && item.workspaceId === workspaceId && item.handle,
  )
  return row?.handle ?? null
}

export function getChatSandbox(
  conversationId: string,
): JobSandboxHandle | null {
  return getRegisteredChatSandbox(conversationId)?.handle ?? null
}

export function getRegisteredChatSandbox(
  conversationId: string,
): RegisteredSandbox | null {
  return (
    [...sandboxes.values()].find(
      (item) => item.kind === "chat" && item.conversationId === conversationId,
    ) ?? null
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
