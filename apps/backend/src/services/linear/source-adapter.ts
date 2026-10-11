import { z } from "zod"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import {
  type LinearSourceScope,
  linearProjects,
  linearScopeSchema,
  linearTeams,
} from "../../domain/workspace-sources/providers/linear.js"
import {
  getLinearConnectionByConnectionId,
  type LinearConnection,
  refreshLinearConnectionTokensWithLock,
} from "../../models/linear-connector.js"
import {
  getLinearOauthAppCreds,
  linearWorkspaceIdentity,
} from "../../models/linear-oauth-app.js"
import type { GitFileChange } from "../git/file-change.js"
import {
  discoverLinearScopes,
  type LinearTokenRefreshHandler,
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
} from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import {
  collectLinearMirrorPages,
  fetchLinearMirrorPage,
  walkLinearMirrorPages,
} from "./content.js"
import { captureLinearContent } from "./sync.js"

/**
 * Each team of a Linear source owns `linear/teams/<key>/`, and each project
 * owns `linear/projects/<id>/`. Under a root, the files keep the layout of
 * the Linear mirror (ADR-022): `issues/`, `projects/`, `teams/`, and so on.
 */
export function linearRootPath(
  root: { kind: "team"; key: string } | { kind: "project"; id: string },
): string {
  return root.kind === "team"
    ? `linear/teams/${root.key}/`
    : `linear/projects/${root.id}/`
}

export function linearManagedPaths(scope: LinearSourceScope): string[] {
  return [
    ...linearTeams(scope).map((key) => linearRootPath({ kind: "team", key })),
    ...linearProjects(scope).map((id) =>
      linearRootPath({ kind: "project", id }),
    ),
  ]
}

type LinearFetchRoot = {
  scope: ParsedLinearRepoConfig["scopes"][number]
  /** "exclude" when one scope of the root excludes customer requests. */
  customerRequests: "exclude" | "limited"
  /** The roots that get the walk's files: one for each spelling of a team key. */
  paths: string[]
}

/**
 * One mirror walk for each distinct team and project of the union of
 * scopes. `teamIdByKey` maps an upper-case team key to its Linear id. A key
 * that Linear does not know has no root, so its managed files go away.
 */
export function linearFetchRoots(
  scopes: readonly LinearSourceScope[],
  teamIdByKey: ReadonlyMap<string, string>,
): LinearFetchRoot[] {
  const roots = new Map<string, LinearFetchRoot>()
  for (const scope of scopes) {
    const add = (
      id: string,
      rootScope: LinearFetchRoot["scope"],
      path: string,
    ): void => {
      const root = roots.get(id) ?? {
        scope: rootScope,
        customerRequests: "limited",
        paths: [],
      }
      if (!root.paths.includes(path)) root.paths.push(path)
      if (scope.customerRequests === "exclude")
        root.customerRequests = "exclude"
      roots.set(id, root)
    }
    for (const key of linearTeams(scope)) {
      const teamId = teamIdByKey.get(key.toUpperCase())
      if (!teamId) continue
      add(
        `team:${teamId}`,
        {
          externalId: teamId,
          type: "team",
          title: key,
          url: null,
          parentExternalId: null,
          teamId,
          teamKey: key,
        },
        linearRootPath({ kind: "team", key }),
      )
    }
    for (const id of linearProjects(scope))
      add(
        `project:${id}`,
        {
          externalId: id,
          type: "project",
          title: id,
          url: null,
          parentExternalId: null,
          teamId: null,
          teamKey: null,
        },
        linearRootPath({ kind: "project", id }),
      )
  }
  return [...roots.values()]
}

/**
 * The part of a Linear webhook that routes it to sources: the team keys and
 * project ids of the changed entity. Empty lists mean "not known", and then
 * every source of the connection syncs.
 */
export const linearSourceEventSchema = z.object({
  teamKeys: z.array(z.string()),
  projectIds: z.array(z.string()),
})
export type LinearSourceEvent = z.infer<typeof linearSourceEventSchema>

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** `ENG-123` gives `ENG`. */
function keyOfIdentifier(identifier: unknown): string | undefined {
  const value = text(identifier)
  const dash = value?.lastIndexOf("-") ?? -1
  return value && dash > 0 ? value.slice(0, dash) : undefined
}

/** Read the team keys and project ids from a verified Linear webhook payload. */
export function linearSourceEventFromPayload(
  payload: Record<string, unknown>,
): LinearSourceEvent {
  const data = record(payload.data)
  const issue = record(data.issue)
  const keys = [
    payload.type === "Team" ? text(data.key) : undefined,
    text(record(data.team).key),
    keyOfIdentifier(data.identifier),
    text(record(issue.team).key),
    keyOfIdentifier(issue.identifier),
  ]
  const projects = [
    payload.type === "Project" ? text(data.id) : undefined,
    text(data.projectId),
    text(record(data.project).id),
    text(issue.projectId),
  ]
  const present = (items: Array<string | undefined>) => [
    ...new Set(items.filter((item): item is string => Boolean(item))),
  ]
  return {
    teamKeys: present(keys.map((key) => key?.toUpperCase())),
    projectIds: present(projects),
  }
}

export function linearEventMatches(
  event: unknown,
  scope: LinearSourceScope,
): boolean {
  const parsed = linearSourceEventSchema.safeParse(event)
  if (!parsed.success) return true
  const { teamKeys, projectIds } = parsed.data
  if (!teamKeys.length && !projectIds.length) return true
  return (
    linearTeams(scope).some((key) => teamKeys.includes(key.toUpperCase())) ||
    linearProjects(scope).some((id) => projectIds.includes(id))
  )
}

function tokenRefresher(input: {
  orgId: string
  connectionId: string
  env: Env
}): LinearTokenRefreshHandler {
  return (expectedRefreshToken, expectedAccessToken) =>
    withOrgDbContext(input.orgId, () =>
      refreshLinearConnectionTokensWithLock({
        ...input,
        expectedRefreshToken,
        expectedAccessToken,
        refresh: async (refreshToken) => {
          const connection = await getLinearConnectionByConnectionId(
            input.orgId,
            input.connectionId,
            input.env,
          )
          const creds = connection
            ? getLinearOauthAppCreds(connection, input.env)
            : undefined
          if (!creds) throw new Error("Linear OAuth is not configured")
          const token = await refreshLinearOAuthToken({
            env: input.env,
            refreshToken,
            creds,
          })
          return {
            accessToken: token.access_token,
            refreshToken: token.refresh_token ?? refreshToken,
            accessTokenExpiresAt: linearTokenExpiresAt(token.expires_in),
          }
        },
      }),
    )
}

async function loadInstalledConnection(input: {
  orgId: string
  connectionId: string
  env: Env
}): Promise<LinearConnection> {
  const connection = await withOrgDbContext(input.orgId, () =>
    getLinearConnectionByConnectionId(
      input.orgId,
      input.connectionId,
      input.env,
    ),
  )
  if (!connection || connection.status !== "installed")
    throw new Error("The Linear connection is not installed")
  return connection
}

/** The teams of the Linear workspace, by upper-case team key. */
async function linearTeamIdsByKey(input: {
  env: Env
  connection: LinearConnection
  onTokenRefresh: LinearTokenRefreshHandler
}): Promise<Map<string, string>> {
  const teams = await discoverLinearScopes({ ...input, teamsOnly: true })
  return new Map(
    teams.flatMap((team) =>
      team.type === "team" && team.teamKey
        ? [[team.teamKey.toUpperCase(), team.externalId] as const]
        : [],
    ),
  )
}

/** Name the team keys of a scope that the Linear workspace does not have. */
export async function checkLinearSourceAccess(input: {
  orgId: string
  connectionId: string
  scope: LinearSourceScope
  env: Env
}): Promise<string | null> {
  if (!linearTeams(input.scope).length) return null
  const teamIdByKey = await linearTeamIdsByKey({
    env: input.env,
    connection: await loadInstalledConnection(input),
    onTokenRefresh: tokenRefresher(input),
  })
  const missing = linearTeams(input.scope).filter(
    (key) => !teamIdByKey.has(key.toUpperCase()),
  )
  return missing.length
    ? `The Linear workspace has no team with the key ${missing.join(", ")}`
    : null
}

/**
 * Fetch the union of Linear scopes: one mirror walk for each team and each
 * project, with the page cursors of the existing mirror (ADR-022). A failure
 * stops the sync, because the frame deletes each managed file that a fetch
 * does not return.
 */
export async function fetchLinearSources(input: {
  orgId: string
  connectionId: string
  scopes: readonly LinearSourceScope[]
  env: Env
}): Promise<GitFileChange[]> {
  const onTokenRefresh = tokenRefresher(input)
  const first = await loadInstalledConnection(input)
  const workspace = linearWorkspaceIdentity(first)
  const teamIdByKey = input.scopes.some((scope) => linearTeams(scope).length)
    ? await linearTeamIdsByKey({
        env: input.env,
        connection: first,
        onTokenRefresh,
      })
    : new Map<string, string>()
  const files: GitFileChange[] = []
  for (const root of linearFetchRoots(input.scopes, teamIdByKey)) {
    const config: ParsedLinearRepoConfig = {
      ...workspace,
      customerRequests: root.customerRequests,
      scopes: [root.scope],
    }
    const pages = await walkLinearMirrorPages({
      config,
      runPage: async (_name, request) =>
        fetchLinearMirrorPage({
          env: input.env,
          connection: await loadInstalledConnection(input),
          config,
          onTokenRefresh,
          request,
        }),
    })
    const collected = collectLinearMirrorPages(pages)
    const captured = await captureLinearContent({
      env: input.env,
      connection: await loadInstalledConnection(input),
      files: collected.files,
      failures: collected.failures,
      existingPaths: [],
      onTokenRefresh,
    })
    if (captured.status !== "completed")
      throw new Error(
        `Linear ${root.scope.type} ${root.scope.externalId} did not sync: ${captured.failures
          .map((failure) => `${failure.type} ${failure.id}: ${failure.message}`)
          .join("; ")}`,
      )
    for (const file of captured.files) {
      if (!file.path.startsWith("linear/"))
        throw new Error(`Linear file ${file.path} is outside linear/`)
      for (const path of root.paths)
        files.push({
          ...file,
          path: `${path}${file.path.slice("linear/".length)}`,
        })
    }
  }
  return files
}

export const linearSourceAdapter: SourceAdapter = {
  provider: "linear",
  managedPaths: (scope) => linearManagedPaths(linearScopeSchema.parse(scope)),
  fetch: (input) =>
    fetchLinearSources({
      ...input,
      scopes: input.scopes.map((scope) => linearScopeSchema.parse(scope)),
    }),
  checkAccess: ({ scope, ...input }) =>
    checkLinearSourceAccess({
      ...input,
      scope: linearScopeSchema.parse(scope),
    }),
  matchesEvent: ({ event, scope }) =>
    linearEventMatches(event, linearScopeSchema.parse(scope)),
}
