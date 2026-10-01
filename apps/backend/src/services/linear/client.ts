import { LinearClient } from "@linear/sdk"
import { z } from "zod"
import type { Env } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import {
  getLinearOauthAppCreds,
  type LinearOauthAppCreds,
} from "../../models/linear-oauth-app.js"
import {
  DiscoverScopesDocument,
  type DiscoverScopesQuery,
} from "./documents.generated.js"
import { linearGraphql } from "./graphql.js"

const LinearOAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1),
  scope: z.union([z.string(), z.array(z.string())]),
})

export type LinearOAuthTokenResponse = z.infer<
  typeof LinearOAuthTokenResponseSchema
>

export type LinearTokenRefreshHandler = (
  expectedRefreshToken: string,
  expectedAccessToken: string,
) => Promise<{
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: string | null
}>

export type LinearDiscoveredScope = {
  externalId: string
  type: "team" | "project" | "document" | "initiative"
  title: string
  url: string | null
  parentExternalId: string | null
  teamId: string | null
  teamKey: string | null
}

function assertLinearOauthAppCreds(
  creds: LinearOauthAppCreds | undefined,
): asserts creds is LinearOauthAppCreds {
  if (!creds?.clientId || !creds.clientSecret) {
    throw new Error("Linear OAuth is not configured")
  }
}

export function linearOAuthRedirectUri(env: Env): string {
  return (
    env.LINEAR_REDIRECT_URI ??
    `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/integrations/linear/callback`
  )
}

export function getLinearOAuthAuthorizeUrl(input: {
  env: Env
  state: string
  creds: LinearOauthAppCreds
}): string {
  assertLinearOauthAppCreds(input.creds)
  const params = new URLSearchParams({
    actor: "user",
    client_id: input.creds.clientId,
    prompt: "consent",
    redirect_uri: linearOAuthRedirectUri(input.env),
    response_type: "code",
    scope: "read",
    state: input.state,
  })
  return `https://linear.app/oauth/authorize?${params.toString()}`
}

async function requestLinearOAuthToken(
  creds: LinearOauthAppCreds,
  body: URLSearchParams,
): Promise<LinearOAuthTokenResponse> {
  assertNotInOrgDbContext()
  assertLinearOauthAppCreds(creds)
  body.set("client_id", creds.clientId)
  body.set("client_secret", creds.clientSecret)
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Linear OAuth token request failed (${response.status})`)
  }
  return LinearOAuthTokenResponseSchema.parse(await response.json())
}

export function linearTokenExpiresAt(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString()
}

export async function exchangeLinearOAuthCode(input: {
  env: Env
  code: string
  creds: LinearOauthAppCreds
}): Promise<LinearOAuthTokenResponse> {
  return requestLinearOAuthToken(
    input.creds,
    new URLSearchParams({
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: linearOAuthRedirectUri(input.env),
    }),
  )
}

export async function refreshLinearOAuthToken(input: {
  env: Env
  refreshToken: string
  creds: LinearOauthAppCreds
}): Promise<LinearOAuthTokenResponse> {
  return requestLinearOAuthToken(
    input.creds,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  )
}

async function refreshConnectionToken(input: {
  env: Env
  connection: LinearConnection
  onTokenRefresh?: LinearTokenRefreshHandler
}): Promise<void> {
  if (!input.connection.refreshToken) {
    throw new Error("Linear connection has no refresh token")
  }
  if (!input.connection.accessToken) {
    throw new Error("Linear connection is missing OAuth credentials")
  }
  const expectedRefreshToken = input.connection.refreshToken
  const expectedAccessToken = input.connection.accessToken
  const refreshWithAppCreds = async () => {
    const creds = getLinearOauthAppCreds(input.connection, input.env)
    assertLinearOauthAppCreds(creds)
    const token = await refreshLinearOAuthToken({
      env: input.env,
      refreshToken: expectedRefreshToken,
      creds,
    })
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? expectedRefreshToken,
      accessTokenExpiresAt: linearTokenExpiresAt(token.expires_in),
    }
  }
  const tokens = input.onTokenRefresh
    ? await input.onTokenRefresh(expectedRefreshToken, expectedAccessToken)
    : await refreshWithAppCreds()
  input.connection.accessToken = tokens.accessToken
  input.connection.refreshToken = tokens.refreshToken
  input.connection.accessTokenExpiresAt = tokens.accessTokenExpiresAt
}

function linearErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined
  }
  return typeof error.status === "number" ? error.status : undefined
}

export async function withLinearClient<T>(
  input: {
    env: Env
    connection: LinearConnection
    onTokenRefresh?: LinearTokenRefreshHandler
  },
  run: (client: LinearClient) => Promise<T>,
): Promise<T> {
  const expiresAt = input.connection.accessTokenExpiresAt
    ? Date.parse(input.connection.accessTokenExpiresAt)
    : Number.NaN
  if (
    input.connection.refreshToken &&
    Number.isFinite(expiresAt) &&
    expiresAt <= Date.now() + 60_000
  ) {
    await refreshConnectionToken(input)
  }

  const requestedAccessToken = input.connection.accessToken
  if (!requestedAccessToken) {
    throw new Error("Linear connection is missing OAuth credentials")
  }
  try {
    return await run(new LinearClient({ accessToken: requestedAccessToken }))
  } catch (error) {
    if (linearErrorStatus(error) !== 401) {
      throw error
    }
    if (
      input.connection.accessToken &&
      input.connection.accessToken !== requestedAccessToken
    ) {
      return run(
        new LinearClient({ accessToken: input.connection.accessToken }),
      )
    }
    if (!input.connection.refreshToken) throw error
    await refreshConnectionToken(input)
    if (!input.connection.accessToken) {
      throw new Error("Linear connection is missing OAuth credentials")
    }
    return run(new LinearClient({ accessToken: input.connection.accessToken }))
  }
}

export async function getLinearWorkspaceIdentity(accessToken: string): Promise<{
  workspaceId: string
  workspaceName: string
  workspaceUrlKey: string | null
  actorUserId: string
}> {
  const client = new LinearClient({ accessToken })
  const viewer = await client.viewer
  const organization = await viewer.organization
  return {
    workspaceId: organization.id,
    workspaceName: organization.name,
    workspaceUrlKey: organization.urlKey ?? null,
    actorUserId: viewer.id,
  }
}

function takeDiscoverPage<T>(
  connection:
    | {
        nodes: T[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    | undefined,
): { nodes: T[]; after: string | null } {
  if (!connection) return { nodes: [], after: null }
  return {
    nodes: connection.nodes,
    after:
      connection.pageInfo.hasNextPage && connection.pageInfo.endCursor
        ? connection.pageInfo.endCursor
        : null,
  }
}

export async function discoverLinearScopes(input: {
  env: Env
  connection: LinearConnection
  onTokenRefresh?: LinearTokenRefreshHandler
}): Promise<LinearDiscoveredScope[]> {
  return withLinearClient(input, async (client) => {
    const accessToken = input.connection.accessToken
    if (!accessToken) {
      throw new Error("Linear connection is missing OAuth credentials")
    }
    const teams: NonNullable<DiscoverScopesQuery["teams"]>["nodes"] = []
    const projects: NonNullable<DiscoverScopesQuery["projects"]>["nodes"] = []
    const documents: NonNullable<DiscoverScopesQuery["documents"]>["nodes"] = []
    const initiatives: NonNullable<
      DiscoverScopesQuery["initiatives"]
    >["nodes"] = []
    let teamsAfter: string | null = null
    let projectsAfter: string | null = null
    let documentsAfter: string | null = null
    let initiativesAfter: string | null = null
    let includeTeams = true
    let includeProjects = true
    let includeDocuments = true
    let includeInitiatives = true

    while (
      includeTeams ||
      includeProjects ||
      includeDocuments ||
      includeInitiatives
    ) {
      const data: DiscoverScopesQuery = await linearGraphql(
        client,
        DiscoverScopesDocument,
        {
          teamsAfter,
          projectsAfter,
          documentsAfter,
          initiativesAfter,
          includeTeams,
          includeProjects,
          includeDocuments,
          includeInitiatives,
        },
        accessToken,
      )
      if (includeTeams) {
        const page = takeDiscoverPage(data.teams)
        teams.push(...page.nodes)
        teamsAfter = page.after
        includeTeams = page.after !== null
      }
      if (includeProjects) {
        const page = takeDiscoverPage(data.projects)
        projects.push(...page.nodes)
        projectsAfter = page.after
        includeProjects = page.after !== null
      }
      if (includeDocuments) {
        const page = takeDiscoverPage(data.documents)
        documents.push(...page.nodes)
        documentsAfter = page.after
        includeDocuments = page.after !== null
      }
      if (includeInitiatives) {
        const page = takeDiscoverPage(data.initiatives)
        initiatives.push(...page.nodes)
        initiativesAfter = page.after
        includeInitiatives = page.after !== null
      }
    }
    const teamById = new Map(teams.map((team) => [team.id, team]))
    const projectScopes = projects.map((project): LinearDiscoveredScope => {
      const team = project.teams.nodes[0]
      return {
        externalId: project.id,
        type: "project",
        title: project.name,
        url: project.url,
        parentExternalId: team?.id ?? null,
        teamId: team?.id ?? null,
        teamKey: team?.key ?? null,
      }
    })

    return [
      ...teams.map(
        (team): LinearDiscoveredScope => ({
          externalId: team.id,
          type: "team",
          title: team.name,
          url: input.connection.workspaceUrlKey
            ? `https://linear.app/${input.connection.workspaceUrlKey}/team/${team.key}`
            : null,
          parentExternalId: null,
          teamId: team.id,
          teamKey: team.key,
        }),
      ),
      ...projectScopes,
      ...documents.map((document): LinearDiscoveredScope => {
        const projectId = document.project?.id ?? null
        const project = projectId
          ? projects.find((candidate) => candidate.id === projectId)
          : undefined
        const teamId =
          projectScopes.find((candidate) => candidate.externalId === projectId)
            ?.teamId ?? null
        const team = teamId ? teamById.get(teamId) : undefined
        return {
          externalId: document.id,
          type: "document",
          title: document.title,
          url: document.url,
          parentExternalId: project?.id ?? null,
          teamId,
          teamKey: team?.key ?? null,
        }
      }),
      ...initiatives.map(
        (initiative): LinearDiscoveredScope => ({
          externalId: initiative.id,
          type: "initiative",
          title: initiative.name,
          url: initiative.url,
          parentExternalId: null,
          teamId: null,
          teamKey: null,
        }),
      ),
    ]
  })
}
