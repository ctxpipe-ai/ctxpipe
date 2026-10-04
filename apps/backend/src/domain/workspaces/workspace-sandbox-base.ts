import {
  bootstrapWorkspace,
  defineWorkspace,
  gitSource,
  type SandboxProvider,
} from "@tanstack/ai-sandbox"
import { withOrgDbContext } from "../../db/client.js"
import {
  BASE_BUILD_LEASE_MS,
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
  updateBuildingBase,
} from "../../models/workspaces.js"
import { getLogger, log } from "../../observability/logger.js"
import { ORG_RUNNING_SANDBOX_LIMIT } from "./chat-lifecycle.js"
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

/** Ready bases for this agent image and Workspace binding, newest first. */
export function readyBases(
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

/** Whether a `building` row's lease still holds at `now`. */
export function baseLeaseHeld(
  row: Pick<SandboxInstanceRecord, "state" | "lastHeartbeatAt"> | null,
  now: number,
): boolean {
  return (
    row?.state === "building" &&
    now - row.lastHeartbeatAt.getTime() < BASE_BUILD_LEASE_MS
  )
}

/**
 * The base a new sandbox starts from, chosen when it is created. The caller
 * holds the Workspace lock (stock `ensure` takes it before create), which is
 * also the lock base cleanup holds, so the chosen base cannot be deleted
 * before the sandbox exists.
 * - A base the provider says is gone is marked failed (cleanup removes it)
 *   and the sandbox starts without one.
 * - When the provider cannot say (an outage), the sandbox starts without the
 *   base this time and the base is kept.
 * `requestBuild`: there is no usable base, or it is stale.
 */
export async function baseForNewSandbox(input: {
  orgId: string
  workspaceId: string
  agent: SandboxAgent
  revision: WorkspaceRevision
  now?: Date
}): Promise<{ ref?: string; requestBuild: boolean }> {
  const now = input.now ?? new Date()
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({ workspaceId: input.workspaceId, kind: "base" }),
  )
  const [base] = readyBases(rows, input.agent, input.revision)
  if (!base?.latestSnapshotId) return { requestBuild: true }
  const context = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    sandboxId: base.id,
  }
  let exists: boolean
  try {
    exists = await workspaceBaseExists(
      input.agent.provider,
      base.latestSnapshotId,
    )
  } catch (error) {
    log.warn({
      step: "workspace-base-check",
      message: `Could not check the Workspace base; starting without it: ${String(error)}`,
      ...context,
    })
    return { requestBuild: false }
  }
  if (!exists) {
    log.warn({
      step: "workspace-base-missing",
      message:
        "A Workspace base's image or snapshot is gone; starting without it",
      ...context,
    })
    await persistSandboxInstance(
      { ...base, state: "destroy_failed" },
      ownershipOf(base),
    )
    return { requestBuild: true }
  }
  // Last start from it: cleanup keeps a current base 30 days after this.
  await heartbeatSandboxInstance(base.id, now, input.orgId)
  return {
    ref: base.latestSnapshotId,
    requestBuild: workspaceBaseIsStale({
      base,
      desiredSha: input.revision.sha,
      now,
    }),
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

/**
 * Build step 1 (`reserve`): decide whether the Workspace needs a base and
 * reserve the build. The base row id comes from the workflow run, so a
 * retried reserve finds its own row. One build at a time per Workspace: the
 * `building` row is the lease, recorded under the Workspace lock. A builder
 * runs a sandbox, so it takes one of the org's 50 slots; at capacity there
 * is no build. Returns the base row id, or null when nothing is to be built.
 */
export async function reserveWorkspaceBaseBuild(input: {
  orgId: string
  workspaceId: string
  runId: string
  agent: SandboxAgent
  now?: Date
}): Promise<string | null> {
  const { orgId, workspaceId } = input
  const id = `base:${workspaceId}:${input.runId}`
  const now = input.now ?? new Date()
  return postgresSandboxLocks(orgId).withLock(
    `workspace-sandboxes:${workspaceId}`,
    async (signal) => {
      const { desired, rows } = await withOrgDbContext(orgId, async () => ({
        desired: await getDesiredWorkspaceRevision(workspaceId),
        rows: await listSandboxInstances({ workspaceId, kind: "base" }),
      }))
      if (rows.some((row) => row.id === id)) return id
      if (!desired) return null
      if (rows.some((row) => baseLeaseHeld(row, now.getTime()))) return null
      const [current] = readyBases(rows, input.agent, desired)
      if (
        current &&
        !workspaceBaseIsStale({ base: current, desiredSha: desired.sha, now })
      )
        return null
      return postgresSandboxLocks(orgId).withLock(
        "org-sandbox-slots",
        async () => {
          if (
            (await countRunningSandboxes(orgId, id)) >=
            ORG_RUNNING_SANDBOX_LIMIT
          ) {
            getLogger().warn(
              "No Workspace base build: the org is at its sandbox limit",
              {
                step: "workspace-base-build",
                orgId,
                workspaceId,
              },
            )
            return null
          }
          signal.throwIfAborted()
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
 * Build step 2 (`build`): start the builder, clone and set up, capture, and
 * publish (state `live`). Every write is one conditional UPDATE that holds
 * only while the lease does and the row still names this builder, so a
 * lapsed or deleted lease stops the build and it deletes what it made. The
 * builder id and then the capture are written as soon as they exist, so a
 * crash at any point leaves them findable. However the attempt ends, its
 * builder is removed (Docker), or stopped and its token revoked (Vercel).
 * Retries (OpenWorkflow): a published row returns its image or snapshot; a
 * recorded capture is published; a failed attempt's builder is deleted first.
 * Returns the image or snapshot id, or null when the lease is gone.
 */
export async function runWorkspaceBaseBuild(input: {
  orgId: string
  baseId: string
  /** Tests pass their own; production uses the deployment's provider. */
  builder?: WorkspaceBaseBuilder
}): Promise<string | null> {
  const { orgId, baseId } = input
  const row = await getSandboxInstance(baseId, orgId)
  if (row?.state === "live" && row.latestSnapshotId) return row.latestSnapshotId
  if (!row?.revision || !row.provider || !baseLeaseHeld(row, Date.now()))
    return null
  const provider = row.provider as RunningSandboxProvider
  const publish = (builderId: string | null, ref: string) =>
    updateBuildingBase({
      id: baseId,
      orgId,
      builderId,
      // Docker's builder is gone once captured; the image is the base.
      set: {
        state: "live",
        providerSandboxId: provider === "docker" ? null : builderId,
      },
    }).then((published) => (published ? ref : null))
  if (row.latestSnapshotId) {
    // Captured before a crash. A Docker builder left running goes now; a
    // Vercel builder owns the snapshot and stays.
    if (provider === "docker" && row.providerSandboxId)
      await deleteWorkspaceBaseArtifacts({
        provider,
        providerSandboxId: row.providerSandboxId,
        latestSnapshotId: null,
      })
    return publish(row.providerSandboxId ?? null, row.latestSnapshotId)
  }
  if (row.providerSandboxId) {
    // A failed attempt's builder.
    await deleteWorkspaceBaseArtifacts(row)
    if (
      !(await updateBuildingBase({
        id: baseId,
        orgId,
        builderId: row.providerSandboxId,
        set: { providerSandboxId: null },
      }))
    )
      return null
  }
  const revision = row.revision
  const builder =
    input.builder ?? (await workspaceBaseBuilder({ provider, orgId, revision }))
  if (builder.agentImage !== row.image) {
    // The deployment changed under the build: drop it.
    await postgresSandboxLocks(orgId).withLock(
      `workspace-sandboxes:${row.workspaceId}`,
      async (signal) => {
        signal.throwIfAborted()
        await deleteSandboxInstance(baseId, orgId, {
          ...ownershipOf(row),
          providerSandboxId: null,
        })
      },
    )
    return null
  }
  const build = await builder.start({
    id: baseId,
    orgId,
    workspaceId: row.workspaceId,
  })
  const made: Pick<
    SandboxInstanceRecord,
    "provider" | "providerSandboxId" | "latestSnapshotId"
  > = { provider, providerSandboxId: build.builderId, latestSnapshotId: null }
  const logger = getLogger()
  const lapsed = async () => {
    await deleteWorkspaceBaseArtifacts(made)
    logger.warn("A Workspace base build lost its lease and stopped", {
      step: "workspace-base-build",
      orgId,
      workspaceId: row.workspaceId,
    })
    return null
  }
  const stillOurs = (set: Parameters<typeof updateBuildingBase>[0]["set"]) =>
    updateBuildingBase({ id: baseId, orgId, builderId: build.builderId, set })
  let recorded = false
  try {
    if (
      !(await updateBuildingBase({
        id: baseId,
        orgId,
        builderId: null,
        set: { providerSandboxId: build.builderId },
      }))
    )
      return await lapsed()
    const started = Date.now()
    await bootstrapWorkspace(
      build.handle,
      workspaceBaseDefinition({
        provider,
        revision,
        cloneToken: builder.cloneToken,
      }),
    )
    const head = await build.handle.process.exec("git rev-parse HEAD")
    const sha = head.stdout.trim()
    if (head.exitCode !== 0 || !sha)
      throw new Error("The base clone has no commit")
    // Still ours before taking a snapshot nobody would publish.
    if (!(await stillOurs({}))) return await lapsed()
    const ref = await build.capture()
    made.latestSnapshotId = ref
    if (
      !(await stillOurs({
        latestSnapshotId: ref,
        revision: { ...revision, sha },
      }))
    )
      return await lapsed()
    // Recorded: from here a retry publishes this capture, so it is kept.
    recorded = true
    const published = await publish(build.builderId, ref)
    if (!published) return await lapsed()
    logger.info(`Built the Workspace base in ${Date.now() - started}ms`, {
      step: "workspace-base-build",
      orgId,
      workspaceId: row.workspaceId,
      ms: Date.now() - started,
    })
    return published
  } catch (error) {
    // Before its capture is recorded nothing of this attempt is kept: the
    // retry starts over. A Vercel builder that failed mid-setup is deleted
    // here rather than left running.
    if (!recorded) await deleteWorkspaceBaseArtifacts(made)
    throw error
  } finally {
    await build.finish()
  }
}
