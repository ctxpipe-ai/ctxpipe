import { LinearClient } from "@linear/sdk"
import { z } from "zod"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"

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

type LinearConnectionPage<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean }
  fetchNext: () => PromiseLike<LinearConnectionPage<T>>
}

export type LinearDiscoveredScope = {
  externalId: string
  type: "team" | "project" | "document" | "initiative"
  title: string
  url: string | null
  parentExternalId: string | null
  teamId: string | null
  teamKey: string | null
}

function assertLinearOAuthConfigured(env: Env): asserts env is Env & {
  LINEAR_CLIENT_ID: string
  LINEAR_CLIENT_SECRET: string
} {
  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
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
}): string {
  assertLinearOAuthConfigured(input.env)
  const params = new URLSearchParams({
    actor: "user",
    client_id: input.env.LINEAR_CLIENT_ID,
    prompt: "consent",
    redirect_uri: linearOAuthRedirectUri(input.env),
    response_type: "code",
    scope: "read",
    state: input.state,
  })
  return `https://linear.app/oauth/authorize?${params.toString()}`
}

async function requestLinearOAuthToken(
  env: Env,
  body: URLSearchParams,
): Promise<LinearOAuthTokenResponse> {
  assertLinearOAuthConfigured(env)
  body.set("client_id", env.LINEAR_CLIENT_ID)
  body.set("client_secret", env.LINEAR_CLIENT_SECRET)
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
}): Promise<LinearOAuthTokenResponse> {
  return requestLinearOAuthToken(
    input.env,
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
}): Promise<LinearOAuthTokenResponse> {
  return requestLinearOAuthToken(
    input.env,
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
  const expectedRefreshToken = input.connection.refreshToken
  const tokens = input.onTokenRefresh
    ? await input.onTokenRefresh(
        expectedRefreshToken,
        input.connection.accessToken,
      )
    : await refreshLinearOAuthToken({
        env: input.env,
        refreshToken: expectedRefreshToken,
      }).then((token) => ({
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? expectedRefreshToken,
        accessTokenExpiresAt: linearTokenExpiresAt(token.expires_in),
      }))
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
  try {
    return await run(new LinearClient({ accessToken: requestedAccessToken }))
  } catch (error) {
    if (linearErrorStatus(error) !== 401) {
      throw error
    }
    if (input.connection.accessToken !== requestedAccessToken) {
      return run(
        new LinearClient({ accessToken: input.connection.accessToken }),
      )
    }
    if (!input.connection.refreshToken) throw error
    await refreshConnectionToken(input)
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

export async function collectLinearConnectionPages<T>(
  firstPage: () => PromiseLike<LinearConnectionPage<T>>,
): Promise<T[]> {
  const nodes: T[] = []
  let page = await firstPage()
  for (;;) {
    nodes.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) return nodes
    page = await page.fetchNext()
  }
}

export async function discoverLinearScopes(input: {
  env: Env
  connection: LinearConnection
  onTokenRefresh?: LinearTokenRefreshHandler
}): Promise<LinearDiscoveredScope[]> {
  return withLinearClient(input, async (client) => {
    const [teams, projects, documents, initiatives] = await Promise.all([
      collectLinearConnectionPages(() => client.teams({ first: 100 })),
      collectLinearConnectionPages(() =>
        client.projects({ first: 100, includeArchived: true }),
      ),
      collectLinearConnectionPages(() =>
        client.documents({ first: 100, includeArchived: true }),
      ),
      collectLinearConnectionPages(() =>
        client.initiatives({ first: 100, includeArchived: true }),
      ),
    ])
    const teamById = new Map(teams.map((team) => [team.id, team]))
    const projectScopes = await Promise.all(
      projects.map(async (project): Promise<LinearDiscoveredScope> => {
        const projectTeams = await project.teams({ first: 1 })
        const team = projectTeams.nodes[0]
        return {
          externalId: project.id,
          type: "project",
          title: project.name,
          url: project.url,
          parentExternalId: team?.id ?? null,
          teamId: team?.id ?? null,
          teamKey: team?.key ?? null,
        }
      }),
    )

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
        const projectId = document.projectId ?? null
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
