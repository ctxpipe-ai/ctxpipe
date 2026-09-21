import { and, eq, sql } from "drizzle-orm"
import { getOrgDb, getSystemDb } from "../db/client.js"
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
}

function readMirror(config: Record<string, unknown>) {
  return parseGithubConnectionStored(config).prMirror
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
  const row = await getGithubConnectionRow(input.orgId, input.connectionId)
  if (!row) throw new Error("GitHub connection not found")
  const db = getOrgDb()
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
  const setupPhase = sameTarget
    ? (current.setupPhase ?? "draft")
    : "initial_sync"
  const pendingConfigPullUrl = sameTarget
    ? (current.pendingConfigPullUrl ?? null)
    : null
  const config = mergeGithubConnectionConfig(
    row.config as Record<string, unknown>,
    {
      prMirror: {
        repositoryId: input.repositoryId,
        branch: input.branch,
        enabled: true,
        setupPhase,
        pendingConfigPullUrl,
      },
    },
  )
  await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
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
  }
}

export async function patchGithubPrMirror(input: {
  orgId: string
  connectionId: string
  patch: {
    setupPhase?: GithubPrMirrorSetupPhase
    pendingConfigPullUrl?: string | null
    enabled?: boolean
  }
}): Promise<void> {
  const row = await getGithubConnectionRow(input.orgId, input.connectionId)
  if (!row) throw new Error("GitHub connection not found")
  const current = readMirror(row.config as Record<string, unknown>) ?? {}
  const config = mergeGithubConnectionConfig(
    row.config as Record<string, unknown>,
    {
      prMirror: {
        ...current,
        ...input.patch,
      },
    },
  )
  const db = getSystemDb()
  await db
    .update(connections)
    .set({ config, updatedAt: new Date() })
    .where(eq(connections.id, input.connectionId))
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
