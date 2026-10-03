import Docker from "dockerode"
import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  getSandboxInstance,
  getWorkspaceById,
  listSandboxInstances,
  ownershipOf,
  persistSandboxInstance,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  CHAT_SESSION_TTL_MS,
  shouldDestroyJobSandbox,
} from "./chat-lifecycle.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { destroyDetachedProviderSandbox } from "./sandbox-provider.js"

/** Bases retain image ownership until every fork has released that image. */
export async function collectUnusedWorkspaceChatBases(
  orgId: string,
  workspaceId: string,
): Promise<number> {
  return postgresSandboxLocks(orgId).withLock(
    `workspace-sandboxes:${workspaceId}`,
    async () => {
      const { workspace, rows } = await withOrgDbContext(orgId, async () => ({
        workspace: await getWorkspaceById(workspaceId),
        rows: await listSandboxInstances({ workspaceId, kind: "chat" }),
      }))
      if (!workspace) return 0
      const bases = rows.filter(
        (row) => !row.conversationId && row.id.startsWith("base:"),
      )
      let destroyed = 0
      let dockerImage: string | undefined
      for (const base of bases) {
        if (
          base.latestSnapshotId &&
          rows.some(
            (row) =>
              row.id !== base.id &&
              row.latestSnapshotId === base.latestSnapshotId,
          )
        )
          continue
        const obsoleteRevision = base.revision
          ? base.revision.sha !== workspace.desiredSha ||
            base.revision.generation !== workspace.desiredGeneration ||
            base.revision.remote.url !== workspace.workspaceRepositoryUrl
          : false
        if (
          base.provider === "docker" &&
          base.image !== null &&
          dockerImage === undefined
        ) {
          dockerImage = (
            await new Docker({ timeout: 30_000 })
              .getImage(workspaceChatDockerImage())
              .inspect()
          ).Id
        }
        const currentImage =
          base.provider === "docker"
            ? (dockerImage ?? null)
            : base.provider === "local-process" ||
                base.provider === "local_process" ||
                base.provider === "unsandboxed"
              ? "1"
              : null
        const obsoleteImage =
          currentImage !== null &&
          base.image !== null &&
          base.image !== currentImage
        const obsolete = obsoleteRevision || obsoleteImage
        const superseded = bases.some(
          (other) =>
            other.id !== base.id &&
            other.lastHeartbeatAt > base.lastHeartbeatAt,
        )
        const idle =
          Date.now() - base.lastHeartbeatAt.getTime() >= CHAT_SESSION_TTL_MS
        if (
          (obsolete || superseded || idle) &&
          (await destroyWorkspaceSandboxUnderFence(base.id, orgId))
        )
          destroyed++
      }
      return destroyed
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
  for (const row of rows) {
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
