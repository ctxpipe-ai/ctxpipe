import {
  deleteSandboxInstance,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  shouldDestroyChatSandbox,
  shouldDestroyJobSandbox,
} from "./chat-lifecycle.js"
import type { JobSandboxHandle } from "./job-worktree.js"

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
  destroy?: () => Promise<void>
  handle?: JobSandboxHandle
}

const sandboxes = new Map<string, RegisteredSandbox>()

export function registerWorkspaceSandbox(
  sandbox: Omit<RegisteredSandbox, "lastHeartbeatAt"> & {
    lastHeartbeatAt?: Date
  },
): void {
  const existing = sandboxes.get(sandbox.id)
  const next: RegisteredSandbox = {
    ...existing,
    ...sandbox,
    handle: sandbox.handle ?? existing?.handle,
    destroy: sandbox.destroy ?? existing?.destroy,
    lastHeartbeatAt:
      sandbox.lastHeartbeatAt ?? existing?.lastHeartbeatAt ?? new Date(),
  }
  sandboxes.set(sandbox.id, next)
  persistSandboxQuietly({
    id: next.id,
    kind: next.kind,
    orgId: next.orgId ?? null,
    workspaceId: next.workspaceId,
    conversationId: next.conversationId ?? null,
    desiredUrl: next.desiredUrl ?? null,
    desiredGeneration: next.desiredGeneration ?? null,
    desiredSha: next.desiredSha ?? null,
    state: "live",
    lastHeartbeatAt: next.lastHeartbeatAt,
  })
}

function persistSandboxQuietly(
  input: Parameters<typeof persistSandboxInstance>[0],
): void {
  try {
    void persistSandboxInstance(input).catch((error) => {
      logSandboxError("persist-sandbox-instance", input.id, error)
    })
  } catch (error) {
    logSandboxError("persist-sandbox-instance", input.id, error)
  }
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
  if (!existing) return
  sandboxes.set(id, { ...existing, lastHeartbeatAt: now })
}

export async function destroySandboxesForConversation(
  conversationId: string,
): Promise<number> {
  const ids = [...sandboxes.values()]
    .filter((row) => row.conversationId === conversationId)
    .map((row) => row.id)
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
  const ids = [...sandboxes.values()]
    .filter(
      (row) =>
        row.workspaceId === workspaceId &&
        (kind === "any" || row.kind === kind),
    )
    .map((row) => row.id)
  let destroyed = 0
  for (const id of ids) {
    if (await destroyWorkspaceSandbox(id)) destroyed += 1
  }
  return destroyed
}

export async function destroyWorkspaceSandbox(id: string): Promise<boolean> {
  const existing = sandboxes.get(id)
  if (!existing) return false
  try {
    await existing.destroy?.()
  } catch (error) {
    logSandboxError("destroy-workspace-sandbox", id, error)
    persistSandboxQuietly({
      id: existing.id,
      kind: existing.kind,
      orgId: existing.orgId ?? null,
      workspaceId: existing.workspaceId,
      conversationId: existing.conversationId ?? null,
      desiredUrl: existing.desiredUrl ?? null,
      desiredGeneration: existing.desiredGeneration ?? null,
      desiredSha: existing.desiredSha ?? null,
      state: "destroy_failed",
      lastHeartbeatAt: existing.lastHeartbeatAt,
    })
    return false
  }
  sandboxes.delete(id)
  try {
    void deleteSandboxInstance(id).catch((error) => {
      logSandboxError("delete-sandbox-instance", id, error)
    })
  } catch (error) {
    logSandboxError("delete-sandbox-instance", id, error)
  }
  return true
}

export function listRegisteredSandboxes(): RegisteredSandbox[] {
  return [...sandboxes.values()]
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
