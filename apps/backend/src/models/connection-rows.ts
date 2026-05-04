import type { connections } from "../db/schema/connections.js"
import {
  CONNECTION_TYPE_FORGE,
  CONNECTION_TYPE_GITHUB,
  CONNECTION_TYPE_NOTION,
} from "../db/schema/connections.js"
import {
  parseForgeConnectionConfig,
  parseGithubConnectionConfig,
  parseNotionConnectionConfig,
  serialiseForgeConnectionConfigForDb,
  serialiseGithubConnectionConfigForDb,
  serialiseNotionConnectionConfigForDb,
} from "../lib/connection-config.js"

export type ConnectionRow = typeof connections.$inferSelect

/** Legacy-shaped object for code that queried `forge_installations` rows. */
export type ForgeInstallationShape = {
  id: string
  orgId: string
  cloudId: string | null
  installationContext: string | null
  installationId: string | null
  appId: string | null
  appSystemToken: string | null
  atlassianApiBaseUrl: string | null
  installedByUserId: string | null
  status: string
  lastEventPayload: unknown
  createdAt: Date
  updatedAt: Date
}

/** Legacy-shaped object for code that queried `github_installations` rows. */
export type GitHubInstallationShape = {
  id: string
  orgId: string
  installationId: number
  accountSlug: string | null
  ingestAllRepositories: boolean
  includeFutureRepos: boolean
  createdAt: Date
  updatedAt: Date
}

export type NotionConnectionShape = {
  id: string
  orgId: string
  accessToken: string | null
  refreshToken: string | null
  botId: string | null
  workspaceId: string | null
  workspaceName: string | null
  workspaceIcon: string | null
  ownerUserId: string | null
  status: string
  lastEventPayload: unknown
  createdAt: Date
  updatedAt: Date
}

export function forgeConnectionToShape(
  row: ConnectionRow,
): ForgeInstallationShape {
  if (row.type !== CONNECTION_TYPE_FORGE) {
    throw new Error("Expected forge connection row")
  }
  const c = parseForgeConnectionConfig(row.config as Record<string, unknown>)
  return {
    id: row.id,
    orgId: row.orgId,
    cloudId: c.cloudId ?? null,
    installationContext: c.installationContext ?? null,
    installationId: c.installationId ?? null,
    appId: c.appId ?? null,
    appSystemToken: c.appSystemToken ?? null,
    atlassianApiBaseUrl: c.atlassianApiBaseUrl ?? null,
    installedByUserId: c.installedByUserId ?? null,
    status: c.status,
    lastEventPayload: c.lastEventPayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function githubConnectionToShape(
  row: ConnectionRow,
): GitHubInstallationShape {
  if (row.type !== CONNECTION_TYPE_GITHUB) {
    throw new Error("Expected github connection row")
  }
  const c = parseGithubConnectionConfig(row.config as Record<string, unknown>)
  return {
    id: row.id,
    orgId: row.orgId,
    installationId: c.installationId,
    accountSlug: c.accountSlug ?? null,
    ingestAllRepositories: c.ingestAllRepositories,
    includeFutureRepos: c.includeFutureRepos,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function notionConnectionToShape(
  row: ConnectionRow,
): NotionConnectionShape {
  if (row.type !== CONNECTION_TYPE_NOTION) {
    throw new Error("Expected notion connection row")
  }
  const c = parseNotionConnectionConfig(row.config as Record<string, unknown>)
  return {
    id: row.id,
    orgId: row.orgId,
    accessToken: c.accessToken ?? null,
    refreshToken: c.refreshToken ?? null,
    botId: c.botId ?? null,
    workspaceId: c.workspaceId ?? null,
    workspaceName: c.workspaceName ?? null,
    workspaceIcon: c.workspaceIcon ?? null,
    ownerUserId: c.ownerUserId ?? null,
    status: c.status,
    lastEventPayload: c.lastEventPayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function forgeShapeToConfig(
  input: Omit<
    ForgeInstallationShape,
    "id" | "orgId" | "createdAt" | "updatedAt"
  >,
): Record<string, unknown> {
  return serialiseForgeConnectionConfigForDb({
    cloudId: input.cloudId,
    installationContext: input.installationContext,
    installationId: input.installationId,
    appId: input.appId,
    appSystemToken: input.appSystemToken,
    atlassianApiBaseUrl: input.atlassianApiBaseUrl,
    installedByUserId: input.installedByUserId,
    status: input.status,
    lastEventPayload: input.lastEventPayload,
  })
}

export function githubShapeToConfig(
  input: Pick<
    GitHubInstallationShape,
    "installationId" | "ingestAllRepositories" | "includeFutureRepos"
  > & { accountSlug?: string | null },
): Record<string, unknown> {
  return serialiseGithubConnectionConfigForDb({
    installationId: input.installationId,
    ingestAllRepositories: input.ingestAllRepositories,
    includeFutureRepos: input.includeFutureRepos,
    accountSlug: input.accountSlug ?? undefined,
  })
}

export function notionShapeToConfig(
  input: Omit<
    NotionConnectionShape,
    "id" | "orgId" | "createdAt" | "updatedAt"
  >,
): Record<string, unknown> {
  return serialiseNotionConnectionConfigForDb({
    accessToken: input.accessToken ?? undefined,
    refreshToken: input.refreshToken ?? undefined,
    botId: input.botId ?? undefined,
    workspaceId: input.workspaceId ?? undefined,
    workspaceName: input.workspaceName ?? undefined,
    workspaceIcon: input.workspaceIcon ?? null,
    ownerUserId: input.ownerUserId ?? undefined,
    status: input.status,
    lastEventPayload: input.lastEventPayload,
  })
}
