import { getLogger } from "../../observability/logger.js"
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
  sandboxes.set(sandbox.id, {
    ...sandbox,
    lastHeartbeatAt: sandbox.lastHeartbeatAt ?? new Date(),
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
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "destroy-workspace-sandbox", sandboxId: id },
    )
  }
  sandboxes.delete(id)
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
  const row = [...sandboxes.values()].find(
    (item) =>
      item.kind === "chat" &&
      item.conversationId === conversationId &&
      item.handle,
  )
  return row?.handle ?? null
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
