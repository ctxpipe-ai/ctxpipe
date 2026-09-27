import { and, eq, sql } from "drizzle-orm"
import {
  type Db,
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
} from "../db/client.js"
import {
  CONNECTION_TYPE_GITHUB,
  connections,
} from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  type GithubPrMirrorSetupPhase,
  parseGithubConnectionStored,
} from "../lib/connection-config.js"
import { generateObjectId } from "../lib/id.js"
import { mergeGithubConnectionConfig } from "./connection-rows.js"
import { getGithubConnectionRow } from "./github-installation.js"
import { DEFAULT_CHECKOUT_KEY, getRepositoryForOrg } from "./repositories.js"

export type GithubPrMirrorBinding = {
  connectionId: string
  orgId: string
  repositoryId: string
  repositoryName: string
  gitUrl: string
  githubConnectionId: string
  branch: string
  enabled: boolean
  setupPhase: GithubPrMirrorSetupPhase
  pendingConfigPullUrl: string | null
  lastContentCommitSha: string | null
  lastContentLaunchToken: string | null
  contentSyncGeneration: number
}

export type GithubPrMirrorPatchResult = {
  applied: boolean
  contentSyncGeneration: number
  repositoryId?: string
  branch?: string
}

function readMirror(config: Record<string, unknown>) {
  return parseGithubConnectionStored(config).prMirror
}

function launchIdentity(
  sha: string | null | undefined,
  token: string | null | undefined,
) {
  return {
    sha: sha ?? null,
    token: token ?? null,
  }
}

function sameLaunchIdentity(
  left: { sha: string | null; token: string | null },
  right: { sha: string | null; token: string | null },
) {
  return left.sha === right.sha && left.token === right.token
}

async function lockGithubPrMirrorConnection(db: Db, connectionId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${connectionId}, 0))`,
  )
}

function mirrorTargetMismatch(
  mirror: ReturnType<typeof readMirror>,
  expected: { repositoryId?: string; branch?: string },
) {
  return (
    (expected.repositoryId != null &&
      mirror?.repositoryId !== expected.repositoryId) ||
    (expected.branch != null && mirror?.branch !== expected.branch)
  )
}

export async function getGithubPrMirrorBinding(
  orgId: string,
  connectionId: string,
): Promise<GithubPrMirrorBinding | null> {
  const row = await getGithubConnectionRow(orgId, connectionId)
  if (!row) return null
  const mirror = readMirror(row.config as Record<string, unknown>)
  if (!mirror?.repositoryId || !mirror.branch) return null
  const repository = await getRepositoryForOrg(orgId, mirror.repositoryId)
  if (!repository?.githubConnectionId) return null
  return {
    connectionId: row.id,
    orgId: row.orgId,
    repositoryId: repository.id,
    repositoryName: repository.name,
    gitUrl: repository.gitUrl,
    githubConnectionId: repository.githubConnectionId,
    branch: mirror.branch,
    enabled: mirror.enabled ?? true,
    setupPhase: mirror.setupPhase ?? "draft",
    pendingConfigPullUrl: mirror.pendingConfigPullUrl ?? null,
    lastContentCommitSha: mirror.lastContentCommitSha ?? null,
    lastContentLaunchToken: mirror.lastContentLaunchToken ?? null,
    contentSyncGeneration: row.contentSyncGeneration,
  }
}

export async function resolveGithubPrMirrorRepository(input: {
  orgId: string
  connectionId: string
  repositoryName: string
  gitUrl: string
  branch: string
}): Promise<string> {
  const db = getOrgDb()
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: repositories.id,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, input.orgId),
          eq(repositories.gitUrl, input.gitUrl),
        ),
      )
      .limit(1)
    if (existing) {
      if (
        existing.githubConnectionId &&
        existing.githubConnectionId !== input.connectionId
      ) {
        throw new Error(
          "Context repository must belong to this GitHub App installation",
        )
      }
      if (!existing.githubConnectionId) {
        await tx
          .update(repositories)
          .set({ githubConnectionId: input.connectionId })
          .where(eq(repositories.id, existing.id))
      }
      return existing.id
    }

    const repositoryId = generateObjectId("repo")
    const [created] = await tx
      .insert(repositories)
      .values({
        id: repositoryId,
        orgId: input.orgId,
        name: input.repositoryName,
        gitUrl: input.gitUrl,
        githubConnectionId: input.connectionId,
      })
      .returning({ id: repositories.id })
    if (!created) throw new Error("Failed to create context repository")

    const [checkout] = await tx
      .insert(repositoryCheckouts)
      .values({
        id: generateObjectId("co"),
        orgId: input.orgId,
        repositoryId,
        ref: input.branch,
        checkoutKey: DEFAULT_CHECKOUT_KEY,
      })
      .returning({ id: repositoryCheckouts.id })
    if (!checkout) throw new Error("Failed to create repository checkout")
    return created.id
  })
}

export async function bindGithubPrMirror(input: {
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
}): Promise<GithubPrMirrorBinding> {
  return withOrgDbContext(input.orgId, async (db) => {
    await lockGithubPrMirrorConnection(db, input.connectionId)
    const [row] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_GITHUB),
        ),
      )
      .limit(1)
      .for("update")
    if (!row) throw new Error("GitHub connection not found")
    const [repository] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        gitUrl: repositories.gitUrl,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.orgId, input.orgId),
        ),
      )
      .limit(1)
    if (!repository) throw new Error("Context repository not found")
    if (repository.githubConnectionId !== input.connectionId) {
      throw new Error(
        "Context repository must belong to this GitHub App installation",
      )
    }
    const current = readMirror(row.config as Record<string, unknown>)
    const sameTarget =
      current?.repositoryId === input.repositoryId &&
      current.branch === input.branch
    const setupPhase = sameTarget ? (current.setupPhase ?? "draft") : "draft"
    const pendingConfigPullUrl = sameTarget
      ? (current.pendingConfigPullUrl ?? null)
      : null
    const lastContentCommitSha = sameTarget
      ? (current.lastContentCommitSha ?? null)
      : null
    const lastContentLaunchToken = sameTarget
      ? (current.lastContentLaunchToken ?? null)
      : null
    const contentSyncGeneration = sameTarget
      ? row.contentSyncGeneration
      : row.contentSyncGeneration + 1
    const config = mergeGithubConnectionConfig(
      row.config as Record<string, unknown>,
      {
        prMirror: {
          repositoryId: input.repositoryId,
          branch: input.branch,
          enabled: true,
          setupPhase,
          pendingConfigPullUrl,
          lastContentCommitSha,
          lastContentLaunchToken,
        },
      },
    )
    await db
      .update(connections)
      .set({
        config,
        contentSyncGeneration,
        ...(sameTarget ? {} : { contentSyncWorkflowRunId: null }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
    return {
      connectionId: row.id,
      orgId: row.orgId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      gitUrl: repository.gitUrl,
      githubConnectionId: repository.githubConnectionId,
      branch: input.branch,
      enabled: true,
      setupPhase,
      pendingConfigPullUrl,
      lastContentCommitSha,
      lastContentLaunchToken,
      contentSyncGeneration,
    }
  })
}

export async function patchGithubPrMirror(input: {
  orgId: string
  connectionId: string
  workflowRunId?: string
  expectedContentSyncGeneration?: number
  expectedRepositoryId?: string
  expectedBranch?: string
  claimContentRun?: boolean
  reserveContentLaunch?: boolean
  claimEnsureStage?: boolean
  patch: {
    setupPhase?: GithubPrMirrorSetupPhase
    pendingConfigPullUrl?: string | null
    enabled?: boolean
    lastContentCommitSha?: string | null
    lastContentLaunchToken?: string | null
  }
}): Promise<GithubPrMirrorPatchResult> {
  return withOrgDbContext(input.orgId, async (db) => {
    const serialize =
      input.claimContentRun ||
      input.reserveContentLaunch ||
      input.claimEnsureStage ||
      input.expectedContentSyncGeneration != null ||
      input.expectedRepositoryId != null ||
      input.expectedBranch != null
    if (serialize) {
      await lockGithubPrMirrorConnection(db, input.connectionId)
    }
    const locked = db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, input.connectionId),
          eq(connections.orgId, input.orgId),
          eq(connections.type, CONNECTION_TYPE_GITHUB),
        ),
      )
      .limit(1)
    const [row] = serialize ? await locked.for("update") : await locked
    if (!row) throw new Error("GitHub connection not found")
    const current = readMirror(row.config as Record<string, unknown>) ?? {}
    if (
      mirrorTargetMismatch(current, {
        repositoryId: input.expectedRepositoryId,
        branch: input.expectedBranch,
      })
    ) {
      return {
        applied: false,
        contentSyncGeneration: row.contentSyncGeneration,
        repositoryId: current.repositoryId ?? undefined,
        branch: current.branch ?? undefined,
      }
    }
    if (
      input.expectedContentSyncGeneration != null &&
      row.contentSyncGeneration !== input.expectedContentSyncGeneration
    ) {
      return {
        applied: false,
        contentSyncGeneration: row.contentSyncGeneration,
        repositoryId: current.repositoryId ?? undefined,
        branch: current.branch ?? undefined,
      }
    }
    const reservedIdentity = launchIdentity(
      input.patch.lastContentCommitSha,
      input.patch.lastContentLaunchToken,
    )
    const currentIdentity = launchIdentity(
      current.lastContentCommitSha,
      current.lastContentLaunchToken,
    )
    const reuseReservedLaunch =
      (input.reserveContentLaunch || input.claimEnsureStage) &&
      sameLaunchIdentity(currentIdentity, reservedIdentity)
    const alreadyOwner =
      input.claimContentRun &&
      Boolean(input.workflowRunId) &&
      row.contentSyncWorkflowRunId === input.workflowRunId
    if (
      input.claimContentRun &&
      input.expectedContentSyncGeneration == null &&
      !alreadyOwner &&
      (current.lastContentCommitSha != null ||
        current.lastContentLaunchToken != null ||
        row.contentSyncWorkflowRunId != null ||
        row.contentSyncGeneration > 0)
    ) {
      return {
        applied: false,
        contentSyncGeneration: row.contentSyncGeneration,
        repositoryId: current.repositoryId ?? undefined,
        branch: current.branch ?? undefined,
      }
    }
    const generation =
      input.reserveContentLaunch || input.claimEnsureStage
        ? reuseReservedLaunch
          ? row.contentSyncGeneration
          : row.contentSyncGeneration + 1
        : input.claimContentRun
          ? input.expectedContentSyncGeneration != null || alreadyOwner
            ? row.contentSyncGeneration
            : row.contentSyncGeneration + 1
          : row.contentSyncGeneration
    const config = mergeGithubConnectionConfig(
      row.config as Record<string, unknown>,
      {
        prMirror: {
          ...current,
          ...input.patch,
        },
      },
    )
    const nextMirror = readMirror(config) ?? current
    await db
      .update(connections)
      .set({
        config,
        ...(input.claimContentRun
          ? {
              contentSyncGeneration: generation,
              contentSyncWorkflowRunId:
                input.workflowRunId ?? row.contentSyncWorkflowRunId,
            }
          : input.reserveContentLaunch || input.claimEnsureStage
            ? {
                contentSyncGeneration: generation,
                ...(reuseReservedLaunch
                  ? {}
                  : { contentSyncWorkflowRunId: null }),
              }
            : {}),
        updatedAt: new Date(),
      })
      .where(
        input.expectedContentSyncGeneration != null
          ? and(
              eq(connections.id, input.connectionId),
              eq(
                connections.contentSyncGeneration,
                input.expectedContentSyncGeneration,
              ),
            )
          : eq(connections.id, input.connectionId),
      )
    return {
      applied: true,
      contentSyncGeneration: generation,
      repositoryId: nextMirror.repositoryId ?? undefined,
      branch: nextMirror.branch ?? undefined,
    }
  })
}

/**
 * Clear pull-request mirror bindings that target a repository being deleted so
 * webhooks and UI stop addressing it. Runs inside the org DB context like the
 * Linear / Notion / Slack equivalents. Returns the number of connections cleared.
 */
export async function clearGithubPrMirrorBindingsForRepository(input: {
  orgId: string
  repositoryId: string
}): Promise<number> {
  const db = getOrgDb()
  const ids = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.orgId, input.orgId),
        eq(connections.type, CONNECTION_TYPE_GITHUB),
        sql`${connections.config}->'prMirror'->>'repositoryId' = ${input.repositoryId}`,
      ),
    )
  let cleared = 0
  for (const { id } of ids) {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
      )
      const [row] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, id),
            eq(connections.orgId, input.orgId),
            eq(connections.type, CONNECTION_TYPE_GITHUB),
            sql`${connections.config}->'prMirror'->>'repositoryId' = ${input.repositoryId}`,
          ),
        )
        .limit(1)
      if (!row) return false
      const current = readMirror(row.config as Record<string, unknown>) ?? {}
      await tx
        .update(connections)
        .set({
          config: mergeGithubConnectionConfig(
            row.config as Record<string, unknown>,
            {
              prMirror: {
                ...current,
                repositoryId: null,
                branch: null,
                enabled: false,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                lastContentCommitSha: null,
                lastContentLaunchToken: null,
              },
            },
          ),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, id))
      return true
    })
    if (updated) cleared += 1
  }
  return cleared
}

export async function listGithubPrMirrorBindingsForRepository(
  repositoryId: string,
): Promise<GithubPrMirrorBinding[]> {
  const db = getSystemDb()
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.type, CONNECTION_TYPE_GITHUB),
        sql`${connections.config}->'prMirror'->>'repositoryId' = ${repositoryId}`,
      ),
    )
  const bindings: GithubPrMirrorBinding[] = []
  for (const row of rows) {
    const binding = await getGithubPrMirrorBinding(row.orgId, row.id)
    if (binding) bindings.push(binding)
  }
  return bindings
}
