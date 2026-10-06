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
  failBuildingBase,
  getDesiredWorkspaceRevision,
  getSandboxInstance,
  heartbeatSandboxInstance,
  isRunningSandboxProvider,
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
 * `requestBuild`: there is no usable base, or it is stale. `failed` marks
 * the chosen base failed when it then cannot start a sandbox.
 */
export async function baseForNewSandbox(input: {
  orgId: string
  workspaceId: string
  agent: SandboxAgent
  revision: WorkspaceRevision
  now?: Date
}): Promise<{
  ref?: string
  requestBuild: boolean
  failed: () => Promise<void>
}> {
  const nothing = async () => undefined
  const now = input.now ?? new Date()
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({ workspaceId: input.workspaceId, kind: "base" }),
  )
  const [base] = readyBases(rows, input.agent, input.revision)
  if (!base?.latestSnapshotId) return { requestBuild: true, failed: nothing }
  const markFailed = async () => {
    const stored = await getSandboxInstance(base.id, input.orgId)
    if (stored?.state === "live")
      await persistSandboxInstance(
        { ...stored, state: "destroy_failed" },
        ownershipOf(stored),
      )
  }
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
    return { requestBuild: false, failed: nothing }
  }
  if (!exists) {
    log.warn({
      step: "workspace-base-missing",
      message:
        "A Workspace base's image or snapshot is gone; starting without it",
      ...context,
    })
    await markFailed()
    return { requestBuild: true, failed: nothing }
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
    failed: markFailed,
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
        desired: await getDesiredWorkspaceRevision(workspaceId, "read", orgId),
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
 * publish. Each write is one conditional UPDATE that holds only while the
 * lease does and the row still names this builder: recording the builder,
 * then recording the capture and publishing it (state `live`) together. So
 * a lapsed or deleted lease stops the build, and it deletes what it made.
 * However the attempt ends, its builder is removed (Docker), or deleted and
 * its token revoked (Vercel). A crash between the capture and its UPDATE
 * leaves a labeled Docker image (the host prune removes it) or a snapshot
 * under the Vercel builder (deleted with it).
 * Retries (OpenWorkflow): a published row returns its image or snapshot; a
 * failed attempt's builder is deleted before the build starts again.
 * Returns the image or snapshot id, or null when the lease is gone.
 */
export async function runWorkspaceBaseBuild(input: {
  orgId: string
  baseId: string
  /** Tests pass their own; production uses the deployment's provider. */
  builder?: WorkspaceBaseBuilder
  /** How often the running build renews its lease. */
  heartbeatMs?: number
}): Promise<string | null> {
  const { orgId, baseId } = input
  const row = await getSandboxInstance(baseId, orgId)
  if (row?.state === "live" && row.latestSnapshotId) return row.latestSnapshotId
  if (
    !row?.revision ||
    !isRunningSandboxProvider(row.provider) ||
    !baseLeaseHeld(row, Date.now())
  )
    return null
  const provider = row.provider
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
  const build = await builder.start({ id: baseId, orgId })
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
  const write = (
    builderId: string | null,
    set: Parameters<typeof updateBuildingBase>[0]["set"],
  ) => updateBuildingBase({ id: baseId, orgId, builderId, set })
  // Renew the lease while the clone and setup run. A failed renewal stops
  // nothing here: the checks before capture and publish find the lost lease.
  const heartbeat = setInterval(
    () => {
      write(build.builderId, {}).catch((error: unknown) =>
        logger.warn(
          `Renewing a Workspace base build's lease failed: ${String(error)}`,
          {
            step: "workspace-base-build",
            orgId,
            workspaceId: row.workspaceId,
          },
        ),
      )
    },
    input.heartbeatMs ?? BASE_BUILD_LEASE_MS / 6,
  )
  try {
    if (!(await write(null, { providerSandboxId: build.builderId })))
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
    if (!(await write(build.builderId, {}))) return await lapsed()
    const ref = await build.capture()
    made.latestSnapshotId = ref
    // Under the Workspace lock, which a create holds while it chooses its
    // base and records its sandbox: a sandbox that chose the old base is
    // recorded before this base supersedes it (Vercel retention reads that).
    const published = await postgresSandboxLocks(orgId).withLock(
      `workspace-sandboxes:${row.workspaceId}`,
      () =>
        write(build.builderId, {
          state: "live",
          latestSnapshotId: ref,
          revision: { ...revision, sha },
          // Docker's builder is gone once captured; the image is the base. A
          // Vercel builder owns its snapshot and is kept.
          providerSandboxId: provider === "docker" ? null : build.builderId,
        }),
    )
    if (!published) return await lapsed()
    logger.info(`Built the Workspace base in ${Date.now() - started}ms`, {
      step: "workspace-base-build",
      orgId,
      workspaceId: row.workspaceId,
      ms: Date.now() - started,
    })
    return ref
  } catch (error) {
    // Nothing of this attempt is kept: the retry starts over. A Vercel
    // builder that failed mid-setup is deleted here, not left running.
    await deleteWorkspaceBaseArtifacts(made)
    throw error
  } finally {
    clearInterval(heartbeat)
    await build.finish()
  }
}

/**
 * After the build's last attempt failed: release its lease at once (a
 * conditional UPDATE to `destroy_failed`), so it stops blocking new builds
 * and holding one of the org's slots. The sweep deletes the row.
 */
export async function releaseFailedBaseBuild(input: {
  orgId: string
  baseId: string
}): Promise<void> {
  await failBuildingBase(input.baseId, input.orgId)
}
