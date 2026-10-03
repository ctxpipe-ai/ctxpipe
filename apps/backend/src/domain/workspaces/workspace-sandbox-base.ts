import { randomUUID } from "node:crypto"
import {
  bootstrapWorkspace,
  defineWorkspace,
  gitSource,
  type SandboxProvider,
} from "@tanstack/ai-sandbox"
import { withOrgDbContext } from "../../db/client.js"
import {
  countRunningSandboxes,
  deleteSandboxInstance,
  getDesiredWorkspaceRevision,
  getSandboxInstance,
  heartbeatSandboxInstance,
  listSandboxInstances,
  ownershipOf,
  persistSandboxInstance,
  type RunningSandboxProvider,
  type SandboxInstanceRecord,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  CHAT_SANDBOX_RETENTION_MS,
  ORG_RUNNING_SANDBOX_LIMIT,
} from "./chat-lifecycle.js"
import {
  WORKSPACE_CHAT_DOCKER_SETUP,
  WORKSPACE_CHAT_VERCEL_SETUP,
} from "./chat-runtime.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import { sameWorkspaceBinding, type WorkspaceRevision } from "./revision.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  deleteWorkspaceBaseArtifacts,
  type SandboxAgent,
  type WorkspaceBaseBuilder,
  workspaceBaseBuilder,
  workspaceBaseExists,
} from "./workspace-base-providers.js"

/** A base is rebuilt once the default branch moved and it is this old. */
export const BASE_STALE_AGE_MS = 24 * 60 * 60_000
/**
 * A `building` row is the build's lease: a build older than this is treated
 * as lost; its steps stop at their next check and cleanup removes it.
 */
export const BASE_BUILD_LEASE_MS = 60 * 60_000

/** Ready bases for this agent image and Workspace binding, newest first. */
function readyBases(
  rows: SandboxInstanceRecord[],
  agent: SandboxAgent,
  revision: WorkspaceRevision,
): SandboxInstanceRecord[] {
  return rows
    .filter(
      (row) =>
        row.kind === "base" &&
        row.state === "live" &&
        row.provider === agent.provider &&
        row.image === agent.image &&
        row.latestSnapshotId &&
        sameWorkspaceBinding(row.revision, revision),
    )
    .sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    )
}

/** Whether the default branch moved and the base is a day old. */
export function workspaceBaseIsStale(input: {
  base: Pick<SandboxInstanceRecord, "revision" | "createdAt">
  desiredSha: string
  now: Date
}): boolean {
  if (input.base.revision?.sha === input.desiredSha) return false
  const builtAt = input.base.createdAt?.getTime() ?? 0
  return input.now.getTime() - builtAt >= BASE_STALE_AGE_MS
}

/**
 * The base a new sandbox starts from, chosen when it is created. The caller
 * holds the Workspace lock (stock `ensure` takes it before create), which is
 * also the lock base cleanup holds, so the chosen base cannot be deleted
 * before the sandbox exists. A base whose image or snapshot is gone is
 * marked failed (cleanup removes it) and the sandbox starts without one.
 * `requestBuild`: there is no usable base, or it is behind the desired commit.
 */
export async function baseForNewSandbox(input: {
  orgId: string
  workspaceId: string
  agent: SandboxAgent
  revision: WorkspaceRevision
  now?: Date
}): Promise<{ ref?: string; requestBuild: boolean }> {
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({ workspaceId: input.workspaceId, kind: "base" }),
  )
  const [base] = readyBases(rows, input.agent, input.revision)
  if (!base?.latestSnapshotId) return { requestBuild: true }
  if (
    !(await workspaceBaseExists(base.provider ?? "", base.latestSnapshotId))
  ) {
    log.warn({
      step: "workspace-base-missing",
      message:
        "A Workspace base's image or snapshot is gone; starting without it",
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      sandboxId: base.id,
    })
    await persistSandboxInstance(
      { ...base, state: "destroy_failed" },
      ownershipOf(base),
    )
    return { requestBuild: true }
  }
  // Last start from it: cleanup keeps a current base 30 days after this.
  await heartbeatSandboxInstance(base.id, input.now ?? new Date(), input.orgId)
  return {
    ref: base.latestSnapshotId,
    requestBuild: base.revision?.sha !== input.revision.sha,
  }
}

/**
 * Docker conversation sandboxes start from the Workspace base image when
 * there is one (stock `dockerSandbox({ image })`), else from the chat image.
 * Resume and destroy do not depend on the image.
 */
export function startingFromBase(input: {
  make: (image?: string) => SandboxProvider
  baseImage: () => Promise<string | undefined>
}): SandboxProvider {
  const plain = input.make()
  return {
    name: plain.name,
    capabilities: () => plain.capabilities(),
    create: async (options) =>
      input.make(await input.baseImage()).create(options),
    resume: (options) => plain.resume(options),
    destroy: (options) => plain.destroy(options),
  }
}

/** What the base builder runs: the stock clone, then the provider's setup. */
function workspaceBaseDefinition(input: {
  provider: RunningSandboxProvider
  revision: WorkspaceRevision
  cloneToken: string
}) {
  return defineWorkspace({
    source: gitSource({
      url: originUrlWithoutCredentials(input.revision.remote.url),
      ref: input.revision.defaultBranch,
      auth: { token: input.cloneToken },
    }),
    setup: [
      ...(input.provider === "docker"
        ? WORKSPACE_CHAT_DOCKER_SETUP
        : WORKSPACE_CHAT_VERCEL_SETUP),
    ],
  })
}

function leaseHeld(row: SandboxInstanceRecord | null, now: number) {
  return (
    row?.state === "building" &&
    now - row.lastHeartbeatAt.getTime() < BASE_BUILD_LEASE_MS
  )
}

/**
 * Build step 1 (`reserve`): decide whether the Workspace needs a base and
 * reserve the build. One build at a time per Workspace: the `building` row
 * is the lease, recorded under the Workspace lock. A builder runs a sandbox,
 * so it takes one of the org's 50 slots; at capacity there is no build.
 * Returns the base row id, or null when nothing is to be built.
 */
export async function reserveWorkspaceBaseBuild(input: {
  orgId: string
  workspaceId: string
  agent: SandboxAgent
  now?: Date
}): Promise<string | null> {
  const { orgId, workspaceId } = input
  const now = input.now ?? new Date()
  return postgresSandboxLocks(orgId).withLock(
    `workspace-sandboxes:${workspaceId}`,
    async () => {
      const { desired, rows } = await withOrgDbContext(orgId, async () => ({
        desired: await getDesiredWorkspaceRevision(workspaceId),
        rows: await listSandboxInstances({ workspaceId, kind: "base" }),
      }))
      if (!desired) return null
      if (rows.some((row) => leaseHeld(row, now.getTime()))) return null
      const [current] = readyBases(rows, input.agent, desired)
      if (
        current &&
        !workspaceBaseIsStale({ base: current, desiredSha: desired.sha, now })
      )
        return null
      const id = `base:${workspaceId}:${randomUUID()}`
      return postgresSandboxLocks(orgId).withLock(
        "org-sandbox-slots",
        async () => {
          if (
            (await countRunningSandboxes(orgId, id)) >=
            ORG_RUNNING_SANDBOX_LIMIT
          ) {
            log.warn({
              step: "workspace-base-build",
              message:
                "No Workspace base build: the org is at its sandbox limit",
              orgId,
              workspaceId,
            })
            return null
          }
          await persistSandboxInstance({
            id,
            kind: "base",
            orgId,
            workspaceId,
            conversationId: null,
            provider: input.agent.provider,
            providerSandboxId: null,
            image: input.agent.image,
            revision: desired,
            state: "building",
            lastHeartbeatAt: now,
          })
          return id
        },
      )
    },
  )
}

/**
 * Build step 2 (`build`): start the builder, clone and set up, capture.
 * The builder id and then the captured image or snapshot are written to the
 * row as soon as they exist, so a crash at any point leaves them findable.
 * Between phases the step checks it still holds the lease; a lapsed or
 * deleted lease stops it and it deletes what it made. Throws for OpenWorkflow
 * to retry; a retry first deletes the builder a failed attempt left, or
 * reuses a capture that finished. Returns null when the lease is gone.
 */
export async function runWorkspaceBaseBuild(input: {
  orgId: string
  baseId: string
  /** Tests pass their own; production uses the deployment's provider. */
  builder?: WorkspaceBaseBuilder
}): Promise<{ ref: string; providerSandboxId: string } | null> {
  const { orgId, baseId } = input
  const initial = await getSandboxInstance(baseId, orgId)
  if (!initial || !leaseHeld(initial, Date.now()) || !initial.revision)
    return null
  const { workspaceId } = initial
  /**
   * Move the row from `from` to `to` if this build still holds the lease.
   * Under the Workspace lock, which every delete of the row also takes, so a
   * row deleted meanwhile is never written back.
   */
  const advance = (from: SandboxInstanceRecord, to: SandboxInstanceRecord) =>
    postgresSandboxLocks(orgId).withLock(
      `workspace-sandboxes:${workspaceId}`,
      async () => {
        const stored = await getSandboxInstance(baseId, orgId)
        if (
          !stored ||
          !leaseHeld(stored, Date.now()) ||
          stored.providerSandboxId !== from.providerSandboxId ||
          stored.latestSnapshotId !== from.latestSnapshotId
        )
          return false
        await persistSandboxInstance(to, ownershipOf(stored))
        return true
      },
    )
  if (initial.latestSnapshotId && initial.providerSandboxId)
    return {
      ref: initial.latestSnapshotId,
      providerSandboxId: initial.providerSandboxId,
    }
  let row = initial
  if (row.providerSandboxId) {
    // A failed attempt's builder.
    await deleteWorkspaceBaseArtifacts(row)
    const cleared = { ...row, providerSandboxId: null }
    if (!(await advance(row, cleared))) return null
    row = cleared
  }
  const revision = initial.revision
  const builder =
    input.builder ??
    (await workspaceBaseBuilder({
      provider: row.provider ?? "",
      orgId,
      revision,
    }))
  if (!builder || builder.agentImage !== row.image) {
    // The deployment changed under the build: drop it.
    await deleteSandboxInstance(baseId, orgId, ownershipOf(row))
    return null
  }
  const build = await builder.start({ id: baseId, orgId, workspaceId })
  let current: SandboxInstanceRecord = {
    ...row,
    providerSandboxId: build.builderId,
  }
  /** The lease is gone: delete what this build made and stop. */
  const lapsed = async () => {
    await deleteWorkspaceBaseArtifacts(current)
    log.warn({
      step: "workspace-base-build",
      message: "A Workspace base build lost its lease and stopped",
      orgId,
      workspaceId,
    })
    return null
  }
  try {
    if (!(await advance(row, current))) return await lapsed()
    const started = Date.now()
    await bootstrapWorkspace(
      build.handle,
      workspaceBaseDefinition({
        provider: builder.provider,
        revision,
        cloneToken: builder.cloneToken,
      }),
    )
    const head = await build.handle.process.exec("git rev-parse HEAD")
    const sha = head.stdout.trim()
    if (head.exitCode !== 0 || !sha)
      throw new Error("The base clone has no commit")
    // Still ours before taking a snapshot nobody would publish.
    if (!(await advance(current, current))) return await lapsed()
    const ref = await build.capture()
    const captured: SandboxInstanceRecord = {
      ...current,
      latestSnapshotId: ref,
      revision: { ...revision, sha },
    }
    // Recorded at once, so a crash from here on leaves the capture findable.
    if (!(await advance(current, captured))) {
      current = captured
      return await lapsed()
    }
    current = captured
    log.info({
      step: "workspace-base-build",
      message: `Built the Workspace base in ${Date.now() - started}ms`,
      orgId,
      workspaceId,
      ms: Date.now() - started,
    })
    // Docker's builder is removed after capture; the image is the base.
    return {
      ref,
      providerSandboxId: builder.provider === "docker" ? ref : build.builderId,
    }
  } finally {
    await build.finish()
  }
}

/**
 * Build step 3 (`publish`): make the base the Workspace's current one. If
 * its row was deleted meanwhile (Workspace deleted or relinked under the
 * Workspace lock), delete what was built instead.
 */
export async function publishWorkspaceBase(input: {
  orgId: string
  workspaceId: string
  baseId: string
  built: { ref: string; providerSandboxId: string }
  provider: RunningSandboxProvider
}): Promise<boolean> {
  const { orgId, workspaceId, baseId, built } = input
  const published = await postgresSandboxLocks(orgId).withLock(
    `workspace-sandboxes:${workspaceId}`,
    async () => {
      const row = await getSandboxInstance(baseId, orgId)
      if (row?.state !== "building" || row.latestSnapshotId !== built.ref)
        return false
      await persistSandboxInstance(
        {
          ...row,
          state: "live",
          providerSandboxId: built.providerSandboxId,
          lastHeartbeatAt: new Date(),
        },
        ownershipOf(row),
      )
      return true
    },
  )
  if (!published)
    await deleteWorkspaceBaseArtifacts({
      provider: input.provider,
      providerSandboxId: built.providerSandboxId,
      latestSnapshotId: built.ref,
    })
  return published
}

/**
 * Delete the Workspace's bases no new conversation should start from:
 * - every base but the current one (newest ready base for the current agent
 *   image and Workspace binding). Sandboxes started from it keep working
 *   without it: measured for Docker (a stopped container restarts after
 *   `rmi --force` of its image; a running one makes the daemon refuse, so
 *   the row waits for a later sweep);
 * - the current base once no conversation started from it for 30 days;
 * - builds past their lease, and deletes that failed.
 * Runs under the Workspace lock, which new sandboxes take to choose their
 * base, so what it reads is what starts see. `destroy` deletes one row and
 * its provider artifacts.
 */
export async function collectUnusedWorkspaceSandboxBases(input: {
  orgId: string
  workspaceId: string
  agent: SandboxAgent
  destroy: (row: SandboxInstanceRecord) => Promise<boolean>
  now?: Date
}): Promise<number> {
  const { orgId, workspaceId } = input
  const now = (input.now ?? new Date()).getTime()
  return postgresSandboxLocks(orgId).withLock(
    `workspace-sandboxes:${workspaceId}`,
    async () => {
      const { rows, desired } = await withOrgDbContext(orgId, async () => ({
        rows: await listSandboxInstances({ workspaceId, kind: "base" }),
        desired: await getDesiredWorkspaceRevision(workspaceId),
      }))
      const current = desired
        ? readyBases(rows, input.agent, desired)[0]
        : undefined
      let deleted = 0
      for (const base of rows) {
        const due =
          base.state === "destroy_failed" ||
          (base.state === "building" && !leaseHeld(base, now)) ||
          (base.state === "live" &&
            (base.id !== current?.id ||
              now - base.lastHeartbeatAt.getTime() >=
                CHAT_SANDBOX_RETENTION_MS))
        if (due && (await input.destroy(base))) deleted += 1
      }
      return deleted
    },
  )
}
