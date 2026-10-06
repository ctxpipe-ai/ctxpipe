import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  getDesiredWorkspaceRevision,
  getSandboxInstance,
  listSandboxInstances,
  ownershipOf,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  CHAT_SANDBOX_RETENTION_MS,
  shouldDestroyJobSandbox,
} from "./chat-lifecycle.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { destroyDetachedProviderSandbox } from "./sandbox-provider.js"
import {
  deleteWorkspaceBaseArtifacts,
  type SandboxAgent,
} from "./workspace-base-providers.js"
import { readyBases } from "./workspace-sandbox-base.js"

/**
 * Delete the Workspace's bases no new sandbox will start from. The current
 * base is the newest ready one for the deployment's agent image and the
 * Workspace binding.
 * - Builds past their lease, and failed deletes.
 * - Docker: every other base at once (a stopped container restarts without
 *   its image, measured; the daemon refuses while a running one uses it, and
 *   the row waits for a later sweep), and the current one once no sandbox
 *   started from it for 30 days.
 * - Vercel: the same, but only once no Vercel conversation sandbox of the
 *   Workspace was created before the base was superseded, that is before a
 *   newer base was published (or before now, for the current one). Whether a
 *   sandbox survives deletion of its source snapshot has not been measured,
 *   so a base is kept while a sandbox that could have started from it
 *   exists; conversation sandboxes are deleted 30 days after last use.
 * Runs under the Workspace lock, which new sandboxes take to choose their
 * base. `agent` is the deployment's provider and agent image; the caller
 * skips cleanup when it cannot be read (a daemon blip never deletes the base
 * new conversations should use).
 */
export async function collectUnusedWorkspaceBases(input: {
  orgId: string
  workspaceId: string
  agent: SandboxAgent
  now?: Date
}): Promise<number> {
  const { orgId, workspaceId, agent: current } = input
  const now = input.now ?? new Date()
  return postgresSandboxLocks(orgId).withLock(
    `workspace-sandboxes:${workspaceId}`,
    async (signal) => {
      const { rows, desired } = await withOrgDbContext(orgId, async () => ({
        rows: await listSandboxInstances({ workspaceId }),
        desired: await getDesiredWorkspaceRevision(workspaceId, "read", orgId),
      }))
      const bases = rows.filter((row) => row.kind === "base")
      const ready = desired ? readyBases(bases, current, desired) : []
      const at = now.getTime()
      /**
       * Vercel: a conversation sandbox created before the base was
       * superseded might use it. A live base's `created_at` is its publish
       * time, so a sandbox started while the next base was still building
       * counts.
       */
      const mayBeInUse = (base: SandboxInstanceRecord) => {
        if (base.provider !== "vercel") return false
        const supersededAt =
          bases
            .filter(
              (other) =>
                other.state === "live" &&
                (other.createdAt?.getTime() ?? 0) >
                  (base.createdAt?.getTime() ?? 0),
            )
            .map((other) => other.createdAt?.getTime() ?? at)
            .sort((a, b) => a - b)[0] ?? at
        return rows.some(
          (row) =>
            row.kind === "chat" &&
            row.provider === "vercel" &&
            (row.createdAt?.getTime() ?? 0) < supersededAt,
        )
      }
      let deleted = 0
      for (const base of bases) {
        const due =
          base.state === "destroy_failed" ||
          (base.state === "building" && !base.leaseHeld) ||
          (base.state === "live" &&
            (base.id !== ready[0]?.id ||
              at - base.lastHeartbeatAt.getTime() >=
                CHAT_SANDBOX_RETENTION_MS) &&
            !mayBeInUse(base))
        if (!due) continue
        signal.throwIfAborted()
        if ((await destroyWorkspaceSandboxUnderFence(base.id, orgId)) === true)
          deleted += 1
      }
      return deleted
    },
  )
}

/** Share allocation's workspace fence, including idle and direct cleanup calls. */
export async function destroyWorkspaceSandbox(
  id: string,
  orgId?: string | null,
): Promise<boolean> {
  assertNotInOrgDbContext()
  const initial = await getSandboxInstance(id, orgId)
  if (!initial) return true
  const destroyed = await postgresSandboxLocks(initial.orgId).withLock(
    `workspace-sandboxes:${initial.workspaceId}`,
    () => destroyWorkspaceSandboxUnderFence(id, initial.orgId),
  )
  return destroyed === true
}

/**
 * Delete a sandbox past retention unless something used it after `lastUse`,
 * checked under its own lock so a resume in flight is never deleted.
 */
export async function destroyUnusedSandbox(
  id: string,
  orgId: string,
  lastUse: Date,
): Promise<"destroyed" | "used" | "failed"> {
  assertNotInOrgDbContext()
  const initial = await getSandboxInstance(id, orgId)
  if (!initial) return "destroyed"
  const outcome = await postgresSandboxLocks(orgId).withLock(
    `workspace-sandboxes:${initial.workspaceId}`,
    () =>
      destroyWorkspaceSandboxUnderFence(
        id,
        orgId,
        (row) => row.lastHeartbeatAt.getTime() !== lastUse.getTime(),
      ),
  )
  return outcome === "kept" ? "used" : outcome ? "destroyed" : "failed"
}

/**
 * The caller owns the workspace fence; native key and image locks stay inside
 * it. `keep` is checked under the sandbox's own lock.
 */
async function destroyWorkspaceSandboxUnderFence(
  id: string,
  orgId: string,
  keep?: (row: SandboxInstanceRecord) => boolean,
): Promise<boolean | "kept"> {
  const initial = await getSandboxInstance(id, orgId)
  if (!initial) return true
  return postgresSandboxLocks(initial.orgId).withLock(
    `sandbox:${id}`,
    async (signal): Promise<boolean | "kept"> => {
      const stored = await getSandboxInstance(id, initial.orgId)
      if (!stored) return true
      if (keep?.(stored)) return "kept"
      if (stored.kind === "base") {
        signal.throwIfAborted()
        try {
          // A running container still uses the image: kept for a later sweep.
          if ((await deleteWorkspaceBaseArtifacts(stored)) === "in-use")
            return false
        } catch (error) {
          signal.throwIfAborted()
          await persistSandboxInstance(
            { ...stored, state: "destroy_failed" },
            ownershipOf(stored),
          )
          log.error({
            step: "destroy-workspace-base",
            sandboxId: id,
            error: error instanceof Error ? error.message : String(error),
          })
          return false
        }
        signal.throwIfAborted()
        await deleteSandboxInstance(id, stored.orgId, ownershipOf(stored))
        return true
      }
      const destroyOwned = async () => {
        signal.throwIfAborted()
        try {
          const snapshotOwners = stored.latestSnapshotId
            ? await withOrgDbContext(stored.orgId, () =>
                listSandboxInstances({ workspaceId: stored.workspaceId }),
              )
            : []
          const lastSnapshotOwner =
            stored.latestSnapshotId &&
            !snapshotOwners.some(
              (row) =>
                row.id !== stored.id &&
                row.latestSnapshotId === stored.latestSnapshotId,
            )
          if (stored.providerSandboxId)
            await destroyDetachedProviderSandbox({
              orgId: stored.orgId,
              provider: stored.provider,
              providerSandboxId: stored.providerSandboxId,
              snapshotId: lastSnapshotOwner
                ? (stored.latestSnapshotId ?? undefined)
                : undefined,
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
        await deleteSandboxInstance(id, stored.orgId, ownershipOf(stored))
        return true
      }
      return stored.latestSnapshotId
        ? postgresSandboxLocks(stored.orgId).withLock(
            `sandbox-snapshot:${stored.latestSnapshotId}`,
            destroyOwned,
          )
        : destroyOwned()
    },
  )
}

async function destroyRows(
  rows: SandboxInstanceRecord[],
  failClosed = false,
  underFence = false,
): Promise<number> {
  let destroyed = 0
  // Bases last: a Docker daemon keeps an image that a container still uses.
  const ordered = [
    ...rows.filter((row) => row.kind !== "base"),
    ...rows.filter((row) => row.kind === "base"),
  ]
  for (const row of ordered) {
    const destroy = underFence
      ? destroyWorkspaceSandboxUnderFence
      : destroyWorkspaceSandbox
    if (await destroy(row.id, row.orgId)) destroyed += 1
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
  return postgresSandboxLocks(input.orgId).withLock(
    `workspace-sandboxes:${input.workspaceId}`,
    async (signal) => {
      const rows = await withOrgDbContext(input.orgId, () =>
        listSandboxInstances({
          conversationId: input.conversationId,
          kind: "chat",
        }),
      )
      await destroyRows(rows, true, true)
      signal.throwIfAborted()
      return withOrgDbContext(input.orgId, fn)
    },
  )
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
  return postgresSandboxLocks(input.orgId).withLock(
    `workspace-sandboxes:${input.workspaceId}`,
    async (signal) => {
      const rows = await withOrgDbContext(input.orgId, () =>
        listSandboxInstances({ workspaceId: input.workspaceId }),
      )
      await destroyRows(rows, true, true)
      signal.throwIfAborted()
      return withOrgDbContext(input.orgId, async () =>
        fn(await listSandboxInstances({ workspaceId: input.workspaceId })),
      )
    },
  )
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
