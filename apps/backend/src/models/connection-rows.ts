import type { z } from "zod"
import type { Env } from "../config/env.js"
import type { connections } from "../db/schema/connections.js"
import {
  CONNECTION_TYPE_FORGE,
  CONNECTION_TYPE_GITHUB,
  CONNECTION_TYPE_LINEAR,
  CONNECTION_TYPE_NOTION,
  CONNECTION_TYPE_SLACK,
} from "../db/schema/connections.js"
import {
  decodeGithubAppCredentials,
  decodeLinearTokens,
  decodeNotionTokens,
  decodeSlackBotToken,
  encodeLinearTokensForDb,
  encodeNotionTokensForDb,
  type githubConnectionConfigStoredSchema,
  type LinearSetupPhase,
  type NotionSetupPhase,
  parseForgeConnectionConfig,
  parseGithubConnectionStored,
  parseLinearConnectionStored,
  parseNotionConnectionConfig,
  parseSlackConnectionStored,
  serialiseForgeConnectionConfigForDb,
  serialiseGithubConnectionConfigForDb,
  serialiseLinearConnectionConfigForDb,
  serialiseNotionConnectionConfigForDb,
  serialiseSlackConnectionConfigForDb,
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
  confluenceSiteHost: string | null
  /** Marketplace / install link for the Forge app (non-secret). */
  confluenceForgeInstallUrl: string | null
  forgeScopedApiToken: string | null
  forgeOperatorEmail: string | null
  provisionStatus: "idle" | "running" | "succeeded" | "failed"
  provisionErrorCode: string | null
  provisionStderr: string | null
  provisionWorkflowRunId: string | null
  lastProvisionAt: string | null
  /** 3LO OAuth app client id (not the secret; secret stays only in `connections.config` JSON). */
  atlassianOAuthClientId: string | null
  createdAt: Date
  updatedAt: Date
}

/** Legacy-shaped object for code that queried `github_installations` rows. */
export type GitHubInstallationShape = {
  id: string
  orgId: string
  installationId: number | null
  accountSlug: string | null
  ingestAllRepositories: boolean
  includeFutureRepos: boolean
  appSlug: string | null
  createdAt: Date
  updatedAt: Date
}

export type LinearConnectionShape = {
  id: string
  orgId: string
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
  workspaceId: string
  workspaceName: string
  workspaceUrlKey: string | null
  actorUserId: string | null
  ownerUserId: string
  status: string
  lastEventPayload: unknown
  repositoryId: string | null
  branch: string | null
  enabled: boolean
  setupPhase: LinearSetupPhase
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
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
  repositoryId: string | null
  branch: string | null
  enabled: boolean
  setupPhase: NotionSetupPhase
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
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
    confluenceSiteHost: c.confluenceSiteHost ?? null,
    confluenceForgeInstallUrl: c.confluenceForgeInstallUrl ?? null,
    forgeScopedApiToken: c.forgeScopedApiToken ?? null,
    forgeOperatorEmail: c.forgeOperatorEmail ?? null,
    provisionStatus: c.provisionStatus,
    provisionErrorCode: c.provisionErrorCode ?? null,
    provisionStderr: c.provisionStderr ?? null,
    provisionWorkflowRunId: c.provisionWorkflowRunId ?? null,
    lastProvisionAt: c.lastProvisionAt ?? null,
    atlassianOAuthClientId: c.atlassianOAuthClientId ?? null,
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
  const c = parseGithubConnectionStored(row.config as Record<string, unknown>)
  return {
    id: row.id,
    orgId: row.orgId,
    installationId: c.installationId ?? null,
    accountSlug: c.accountSlug ?? null,
    ingestAllRepositories: c.ingestAllRepositories,
    includeFutureRepos: c.includeFutureRepos,
    appSlug: c.appSlug ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function linearConnectionToShape(
  row: ConnectionRow,
  env: Env,
): LinearConnectionShape {
  if (row.type !== CONNECTION_TYPE_LINEAR) {
    throw new Error("Expected Linear connection row")
  }
  const config = parseLinearConnectionStored(
    row.config as Record<string, unknown>,
  )
  const tokens = decodeLinearTokens(config, env)
  if (!tokens) {
    throw new Error("Linear connection is missing OAuth credentials")
  }
  return {
    id: row.id,
    orgId: row.orgId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: config.accessTokenExpiresAt ?? null,
    workspaceId: config.workspaceId,
    workspaceName: config.workspaceName,
    workspaceUrlKey: config.workspaceUrlKey ?? null,
    actorUserId: config.actorUserId ?? null,
    ownerUserId: config.ownerUserId,
    status: config.status,
    lastEventPayload: config.lastEventPayload,
    repositoryId: config.repositoryId,
    branch: config.branch,
    enabled: config.enabled,
    setupPhase: config.setupPhase,
    pendingConfigPullUrl: config.pendingConfigPullUrl,
    pendingConfigPrCreating: config.pendingConfigPrCreating,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function notionConnectionToShape(
  row: ConnectionRow,
  env: Env,
): NotionConnectionShape {
  if (row.type !== CONNECTION_TYPE_NOTION) {
    throw new Error("Expected notion connection row")
  }
  const c = parseNotionConnectionConfig(row.config as Record<string, unknown>)
  const tokens = decodeNotionTokens(c, env)
  return {
    id: row.id,
    orgId: row.orgId,
    accessToken: tokens?.accessToken ?? null,
    refreshToken: tokens?.refreshToken ?? null,
    botId: c.botId ?? null,
    workspaceId: c.workspaceId ?? null,
    workspaceName: c.workspaceName ?? null,
    workspaceIcon: c.workspaceIcon ?? null,
    ownerUserId: c.ownerUserId ?? null,
    status: c.status,
    lastEventPayload: c.lastEventPayload,
    repositoryId: c.repositoryId,
    branch: c.branch,
    enabled: c.enabled,
    setupPhase: c.setupPhase,
    pendingConfigPullUrl: c.pendingConfigPullUrl,
    pendingConfigPrCreating: c.pendingConfigPrCreating,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function forgeShapeToConfig(
  input: Omit<
    ForgeInstallationShape,
    "id" | "orgId" | "createdAt" | "updatedAt"
  >,
  options?: {
    /** Keep `atlassianOAuthClientSecret` when reshaping; it is not part of `ForgeInstallationShape`. */
    preserveOauthClientSecretFromConfig?: Record<string, unknown> | null
  },
): Record<string, unknown> {
  const out = serialiseForgeConnectionConfigForDb({
    cloudId: input.cloudId,
    installationContext: input.installationContext,
    installationId: input.installationId,
    appId: input.appId,
    appSystemToken: input.appSystemToken,
    atlassianApiBaseUrl: input.atlassianApiBaseUrl,
    installedByUserId: input.installedByUserId,
    status: input.status,
    lastEventPayload: input.lastEventPayload,
    confluenceSiteHost: input.confluenceSiteHost,
    confluenceForgeInstallUrl: input.confluenceForgeInstallUrl,
    forgeScopedApiToken: input.forgeScopedApiToken,
    forgeOperatorEmail: input.forgeOperatorEmail,
    provisionStatus: input.provisionStatus,
    provisionErrorCode: input.provisionErrorCode,
    provisionStderr: input.provisionStderr,
    provisionWorkflowRunId: input.provisionWorkflowRunId,
    lastProvisionAt: input.lastProvisionAt,
    atlassianOAuthClientId: input.atlassianOAuthClientId,
    atlassianOAuthClientSecret:
      typeof options?.preserveOauthClientSecretFromConfig
        ?.atlassianOAuthClientSecret === "string"
        ? options.preserveOauthClientSecretFromConfig.atlassianOAuthClientSecret
        : null,
  }) as Record<string, unknown>
  const prior = options?.preserveOauthClientSecretFromConfig
  if (
    prior &&
    typeof prior.atlassianOAuthClientSecret === "string" &&
    prior.atlassianOAuthClientSecret.length > 0 &&
    (out.atlassianOAuthClientSecret == null ||
      out.atlassianOAuthClientSecret === "")
  ) {
    out.atlassianOAuthClientSecret = prior.atlassianOAuthClientSecret
  }
  return out
}

export function githubShapeToConfig(
  input: Pick<
    GitHubInstallationShape,
    | "installationId"
    | "ingestAllRepositories"
    | "includeFutureRepos"
    | "appSlug"
  > & { accountSlug?: string | null },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const base = {
    installationId: input.installationId ?? undefined,
    ingestAllRepositories: input.ingestAllRepositories,
    includeFutureRepos: input.includeFutureRepos,
    accountSlug: input.accountSlug ?? undefined,
    appSlug: input.appSlug ?? undefined,
    ...extra,
  }
  return serialiseGithubConnectionConfigForDb(base)
}

export function linearShapeToConfig(
  input: Omit<
    LinearConnectionShape,
    "id" | "orgId" | "createdAt" | "updatedAt"
  >,
  env: Env,
): Record<string, unknown> {
  return serialiseLinearConnectionConfigForDb({
    ...encodeLinearTokensForDb(
      {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
      },
      env,
    ),
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    workspaceUrlKey: input.workspaceUrlKey,
    actorUserId: input.actorUserId,
    ownerUserId: input.ownerUserId,
    status: input.status,
    lastEventPayload: input.lastEventPayload,
    repositoryId: input.repositoryId,
    branch: input.branch,
    enabled: input.enabled,
    setupPhase: input.setupPhase,
    pendingConfigPullUrl: input.pendingConfigPullUrl,
    pendingConfigPrCreating: input.pendingConfigPrCreating,
  })
}

/** Merge non-secret fields into existing github connection config. */
export function mergeGithubConnectionConfig(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...patch }
  return serialiseGithubConnectionConfigForDb(
    merged as z.input<typeof githubConnectionConfigStoredSchema>,
  )
}

export function githubRowHasAppCredentials(
  row: ConnectionRow,
  env: Env,
): boolean {
  if (row.type !== CONNECTION_TYPE_GITHUB) return false
  const stored = parseGithubConnectionStored(
    row.config as Record<string, unknown>,
  )
  return decodeGithubAppCredentials(stored, env) != null
}

export function notionShapeToConfig(
  input: Omit<
    NotionConnectionShape,
    "id" | "orgId" | "createdAt" | "updatedAt"
  >,
  env: Env,
): Record<string, unknown> {
  const tokens = input.accessToken
    ? encodeNotionTokensForDb(
        {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
        },
        env,
      )
    : {}
  return serialiseNotionConnectionConfigForDb({
    ...tokens,
    botId: input.botId ?? undefined,
    workspaceId: input.workspaceId ?? undefined,
    workspaceName: input.workspaceName ?? undefined,
    workspaceIcon: input.workspaceIcon ?? null,
    ownerUserId: input.ownerUserId ?? undefined,
    status: input.status,
    lastEventPayload: input.lastEventPayload,
    repositoryId: input.repositoryId,
    branch: input.branch,
    enabled: input.enabled,
    setupPhase: input.setupPhase,
    pendingConfigPullUrl: input.pendingConfigPullUrl,
    pendingConfigPrCreating: input.pendingConfigPrCreating,
  })
}

/** Runtime shape for Slack connections (bot token decrypted only when needed). */
export type SlackConnectionShape = {
  id: string
  orgId: string
  botTokenEnc: string | null
  teamId: string | null
  teamName: string | null
  botUserId: string | null
  appId: string | null
  ownerUserId: string | null
  status: string
  lastEventPayload: unknown
  createdAt: Date
  updatedAt: Date
}

export function slackConnectionToShape(row: ConnectionRow): SlackConnectionShape {
  if (row.type !== CONNECTION_TYPE_SLACK) {
    throw new Error("Expected slack connection row")
  }
  const c = parseSlackConnectionStored(row.config as Record<string, unknown>)
  return {
    id: row.id,
    orgId: row.orgId,
    botTokenEnc: c.botTokenEnc ?? null,
    teamId: c.teamId ?? null,
    teamName: c.teamName ?? null,
    botUserId: c.botUserId ?? null,
    appId: c.appId ?? null,
    ownerUserId: c.ownerUserId ?? null,
    status: c.status,
    lastEventPayload: c.lastEventPayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function slackShapeToConfig(
  input: Omit<
    SlackConnectionShape,
    "id" | "orgId" | "createdAt" | "updatedAt"
  >,
): Record<string, unknown> {
  return serialiseSlackConnectionConfigForDb({
    botTokenEnc: input.botTokenEnc,
    teamId: input.teamId,
    teamName: input.teamName,
    botUserId: input.botUserId,
    appId: input.appId,
    ownerUserId: input.ownerUserId,
    status: input.status,
    lastEventPayload: input.lastEventPayload,
  })
}

export function slackRowHasBotToken(row: ConnectionRow, env: Env): boolean {
  if (row.type !== CONNECTION_TYPE_SLACK) return false
  const stored = parseSlackConnectionStored(row.config as Record<string, unknown>)
  return decodeSlackBotToken(stored, env) != null
}
