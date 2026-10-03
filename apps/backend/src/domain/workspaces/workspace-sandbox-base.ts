import { randomUUID } from "node:crypto"
import {
  bootstrapWorkspace,
  defineWorkspace,
  gitSource,
} from "@tanstack/ai-sandbox"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import {
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
  WORKSPACE_CHAT_DOCKER_SETUP,
  WORKSPACE_CHAT_VERCEL_SETUP,
} from "./chat-runtime.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import { sameWorkspaceBinding, type WorkspaceRevision } from "./revision.js"
import {
  postgresSandboxLocks,
  withSandboxLockIfFree,
} from "./sandbox-lock-store.js"
import { discoverSandboxProvider } from "./sandbox-provider.js"
import {
  deleteWorkspaceBaseArtifacts,
  type WorkspaceBaseBuilder,
  workspaceBaseBuilder,
} from "./workspace-base-providers.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/** A base is stale once its commit is this old and the default branch has moved. */
export const BASE_STALE_AGE_MS = 24 * 60 * 60_000
/**
 * ...or once the default branch is this many commits ahead of it. Workspace
 * repositories take many small automated commits (hydrate, connector
 * mirrors), so fifty is about a busy day. Below that, the pre-turn fetch of
 * one commit stays small; above it, a rebuild (seconds, off the critical
 * path) is cheaper than every new conversation fetching the backlog.
 */
export const BASE_STALE_COMMITS = 50
/**
 * A base chosen for a new conversation is kept at least this long, so the
 * conversation's create never finds it deleted between choice and start.
 */
export const BASE_START_GRACE_MS = 10 * 60_000
/** The Workspace's current base is deleted once no conversation started from it for this long. */
export const BASE_UNUSED_MS = 7 * 24 * 60 * 60_000

const BASE_MARK = "+base:"

/**
 * A conversation sandbox's image identity, part of its sandbox key and kept
 * in its row: the agent image, plus the base it started from. A new base
 * gives new conversations new sandboxes; existing ones keep theirs.
 */
export function conversationImageIdentity(
  agentImage: string,
  baseRef?: string,
): string {
  return baseRef ? `${agentImage}${BASE_MARK}${baseRef}` : agentImage
}

/** The base a conversation sandbox started from, if any. */
export function baseRefOfIdentity(
  identity: string | null | undefined,
): string | undefined {
  const at = identity?.indexOf(BASE_MARK) ?? -1
  return identity && at >= 0 ? identity.slice(at + BASE_MARK.length) : undefined
}

function agentImageOfIdentity(identity: string | null | undefined) {
  const at = identity?.indexOf(BASE_MARK) ?? -1
  return identity && at >= 0 ? identity.slice(0, at) : identity
}

function readyBases(
  rows: SandboxInstanceRecord[],
  input: {
    provider: string
    agentImage?: string
    revision: WorkspaceRevision
  },
): SandboxInstanceRecord[] {
  return rows
    .filter(
      (row) =>
        row.kind === "base" &&
        row.state === "live" &&
        row.provider === input.provider &&
        row.latestSnapshotId &&
        (input.agentImage === undefined || row.image === input.agentImage) &&
        sameWorkspaceBinding(row.revision, input.revision),
    )
    .sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    )
}

/**
 * Which image a conversation's sandbox uses. A conversation that already has
 * a sandbox for this agent image and Workspace binding keeps it (and the base
 * it started from). A new one starts from the Workspace's newest base; when
 * there is none, or it is behind, it starts as before and a build is
 * requested in the background. Never waits for a build.
 */
export async function chooseConversationSandboxBase(input: {
  orgId: string
  workspaceId: string
  conversationId: string
  provider: RunningSandboxProvider
  agentImage: string
  revision: WorkspaceRevision
  /** Files reads attach to an existing sandbox; they never start one. */
  existingOnly?: boolean
  now?: Date
}): Promise<{ identity: string; baseRef?: string; requestBuild: boolean }> {
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({ workspaceId: input.workspaceId }),
  )
  const [existing] = rows
    .filter(
      (row) =>
        row.kind === "chat" &&
        row.conversationId === input.conversationId &&
        row.provider === input.provider &&
        agentImageOfIdentity(row.image) === input.agentImage &&
        sameWorkspaceBinding(row.revision, input.revision),
    )
    // Most recently used, should a race have left two.
    .sort((a, b) => b.lastHeartbeatAt.getTime() - a.lastHeartbeatAt.getTime())
  if (existing?.image) {
    const baseRef = baseRefOfIdentity(existing.image)
    return {
      identity: existing.image,
      ...(baseRef ? { baseRef } : {}),
      requestBuild: false,
    }
  }
  if (input.existingOnly)
    return { identity: input.agentImage, requestBuild: false }
  const [base] = readyBases(rows, input)
  if (!base?.latestSnapshotId)
    return { identity: input.agentImage, requestBuild: true }
  // Chosen: keeps it from cleanup while the conversation starts from it.
  await heartbeatSandboxInstance(base.id, input.now ?? new Date(), input.orgId)
  return {
    identity: conversationImageIdentity(
      input.agentImage,
      base.latestSnapshotId,
    ),
    baseRef: base.latestSnapshotId,
    requestBuild: base.revision?.sha !== input.revision.sha,
  }
}

/** Whether a base has fallen well behind the Workspace's default branch. */
export function workspaceBaseIsStale(input: {
  base: Pick<SandboxInstanceRecord, "revision" | "createdAt">
  desiredSha: string
  now: Date
  /** Commits the default branch is ahead of the base; null when unknown. */
  commitsBehind: number | null
}): boolean {
  if (input.base.revision?.sha === input.desiredSha) return false
  const builtAt = input.base.createdAt?.getTime() ?? 0
  if (input.now.getTime() - builtAt >= BASE_STALE_AGE_MS) return true
  return (
    input.commitsBehind !== null && input.commitsBehind > BASE_STALE_COMMITS
  )
}

/**
 * Commits on the default branch since the base's commit, from GitHub's
 * compare API; null for other hosts or when GitHub cannot say.
 */
export async function githubCommitsBehind(input: {
  orgId: string
  revision: WorkspaceRevision
  baseSha: string
}): Promise<number | null> {
  const repo = githubRepoFullNameFromWorkspaceUrl(input.revision.remote.url)
  if (!repo) return null
  try {
    const token = await getRepoReadCloneToken(
      input.orgId,
      parseEnv(process.env as Record<string, string | undefined>),
      {
        githubConnectionId: input.revision.remote.connectionId ?? undefined,
        repoFullName: repo,
      },
    )
    if (!token) return null
    const response = await fetch(
      `https://api.github.com/repos/${repo}/compare/${input.baseSha}...${input.revision.sha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    )
    if (!response.ok) return null
    const body = (await response.json()) as { ahead_by?: unknown }
    return typeof body.ahead_by === "number" ? body.ahead_by : null
  } catch {
    return null
  }
}

/** What the base sandbox runs: the stock clone, then the provider's setup. */
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

export type WorkspaceBaseBuildOutcome =
  | "built"
  | "fresh"
  | "busy"
  | "skipped"
  | "failed"

/**
 * Build the Workspace's base if it has none for the current agent image and
 * binding, or if the one it has is stale. One build at a time per Workspace:
 * a build holds `workspace-base:<workspace>`; a second caller returns `busy`
 * at once. The Workspace lock `workspace-sandboxes:<workspace>` is held only
 * to record the build and its builder, and to publish the result, so Workspace
 * deletion and relink (which destroy every row under that lock) either see
 * the builder or are seen by the publish step, which then deletes what it
 * built. Conversation starts never wait for a build.
 */
export async function buildWorkspaceSandboxBase(input: {
  orgId: string
  workspaceId: string
  /** Tests pass their own; production uses the deployment's provider. */
  builder?: WorkspaceBaseBuilder
  commitsBehind?: (input: {
    revision: WorkspaceRevision
    baseSha: string
  }) => Promise<number | null>
  now?: () => Date
}): Promise<WorkspaceBaseBuildOutcome> {
  const { orgId, workspaceId } = input
  const now = input.now ?? (() => new Date())
  const outcome = await withSandboxLockIfFree(
    orgId,
    `workspace-base:${workspaceId}`,
    async (): Promise<WorkspaceBaseBuildOutcome> => {
      const desired = await withOrgDbContext(orgId, () =>
        getDesiredWorkspaceRevision(workspaceId),
      )
      if (!desired) return "skipped"
      const builder =
        input.builder ??
        (await workspaceBaseBuilder({
          provider: await discoverSandboxProvider(),
          orgId,
          revision: desired,
        }))
      if (!builder) return "skipped"
      const rows = await withOrgDbContext(orgId, () =>
        listSandboxInstances({ workspaceId, kind: "base" }),
      )
      const [current] = readyBases(rows, {
        provider: builder.provider,
        agentImage: builder.agentImage,
        revision: desired,
      })
      if (current?.revision) {
        const baseSha = current.revision.sha
        const commitsBehind =
          baseSha === desired.sha
            ? 0
            : await (
                input.commitsBehind ??
                ((args) => githubCommitsBehind({ orgId, ...args }))
              )({ revision: desired, baseSha })
        if (
          !workspaceBaseIsStale({
            base: current,
            desiredSha: desired.sha,
            now: now(),
            commitsBehind,
          })
        )
          return "fresh"
      }
      const id = `base:${workspaceId}:${randomUUID()}`
      const reserved: SandboxInstanceRecord = {
        id,
        kind: "base",
        orgId,
        workspaceId,
        conversationId: null,
        provider: builder.provider,
        providerSandboxId: null,
        image: builder.agentImage,
        revision: desired,
        state: "building",
        lastHeartbeatAt: now(),
      }
      const build = await postgresSandboxLocks(orgId).withLock(
        `workspace-sandboxes:${workspaceId}`,
        async () => {
          await persistSandboxInstance(reserved)
          try {
            const started = await builder.start({ id, orgId, workspaceId })
            await persistSandboxInstance(
              { ...reserved, providerSandboxId: started.builderId },
              ownershipOf(reserved),
            )
            return started
          } catch (error) {
            await deleteSandboxInstance(id, orgId, ownershipOf(reserved))
            throw error
          }
        },
      )
      const building = { ...reserved, providerSandboxId: build.builderId }
      let captured: { ref: string; providerSandboxId: string }
      let sha: string
      const started = Date.now()
      try {
        await bootstrapWorkspace(
          build.handle,
          workspaceBaseDefinition({
            provider: builder.provider,
            revision: desired,
            cloneToken: builder.cloneToken,
          }),
        )
        const head = await build.handle.process.exec("git rev-parse HEAD")
        sha = head.stdout.trim()
        if (head.exitCode !== 0 || !sha)
          throw new Error("The base clone has no commit")
        captured = await build.capture()
      } catch (error) {
        log.error({
          step: "workspace-base-build",
          message: `Building the Workspace base failed: ${String(error)}`,
          orgId,
          workspaceId,
        })
        await build.abandon().catch(() => undefined)
        await deleteSandboxInstance(id, orgId, ownershipOf(building)).catch(
          () => undefined,
        )
        return "failed"
      }
      const published = await postgresSandboxLocks(orgId).withLock(
        `workspace-sandboxes:${workspaceId}`,
        async () => {
          const row = await getSandboxInstance(id, orgId)
          // Destroyed meanwhile (Workspace deleted or relinked).
          if (!row) return false
          await persistSandboxInstance(
            {
              ...row,
              state: "live",
              providerSandboxId: captured.providerSandboxId,
              latestSnapshotId: captured.ref,
              revision: { ...desired, sha },
              lastHeartbeatAt: now(),
            },
            ownershipOf(row),
          )
          return true
        },
      )
      if (!published) {
        await deleteWorkspaceBaseArtifacts({
          provider: builder.provider,
          providerSandboxId: captured.providerSandboxId,
          latestSnapshotId: captured.ref,
        })
        return "skipped"
      }
      log.info({
        step: "workspace-base-build",
        message: `Built the Workspace base in ${Date.now() - started}ms`,
        orgId,
        workspaceId,
        ms: Date.now() - started,
      })
      return "built"
    },
  )
  return outcome.busy ? "busy" : outcome.value
}

/**
 * Delete the Workspace's bases that are no longer needed:
 * - superseded or obsolete (a newer base, another agent image or provider,
 *   a relinked Workspace) once no conversation sandbox started from them;
 * - the current base once no conversation started from it for 7 days;
 * - builds that were lost, and deletes that failed.
 * Skipped while a build runs (which also makes any `building` row a lost
 * build). `destroy` deletes one row and its provider artifacts; the caller's
 * Workspace lock is held.
 */
export async function collectUnusedWorkspaceSandboxBases(input: {
  orgId: string
  workspaceId: string
  destroy: (row: SandboxInstanceRecord) => Promise<boolean>
  /** The deployment's provider and agent image; image undefined when unreadable. */
  agent?: { provider: string; image?: string }
  now?: Date
}): Promise<number> {
  const { orgId, workspaceId } = input
  const now = (input.now ?? new Date()).getTime()
  const outcome = await withSandboxLockIfFree(
    orgId,
    `workspace-base:${workspaceId}`,
    () =>
      postgresSandboxLocks(orgId).withLock(
        `workspace-sandboxes:${workspaceId}`,
        async () => {
          const { rows, desired } = await withOrgDbContext(orgId, async () => ({
            rows: await listSandboxInstances({ workspaceId }),
            desired: await getDesiredWorkspaceRevision(workspaceId),
          }))
          const bases = rows.filter((row) => row.kind === "base")
          const current =
            desired && input.agent
              ? readyBases(bases, {
                  provider: input.agent.provider,
                  agentImage: input.agent.image,
                  revision: desired,
                })[0]
              : undefined
          let deleted = 0
          for (const base of bases) {
            const used = now - base.lastHeartbeatAt.getTime()
            const due =
              base.state === "destroy_failed" ||
              base.state === "building" ||
              (base.state === "live" &&
                used >= BASE_START_GRACE_MS &&
                !rows.some(
                  (row) =>
                    row.kind === "chat" &&
                    base.latestSnapshotId &&
                    baseRefOfIdentity(row.image) === base.latestSnapshotId,
                ) &&
                (base.id !== current?.id || used >= BASE_UNUSED_MS))
            if (due && (await input.destroy(base))) deleted += 1
          }
          return deleted
        },
      ),
  )
  return outcome.busy ? 0 : outcome.value
}
