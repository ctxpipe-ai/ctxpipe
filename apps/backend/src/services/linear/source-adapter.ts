import { z } from "zod"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import {
  type LinearSourceScope,
  linearScopeSchema,
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
    ...scope.teams.map((team) =>
      linearRootPath({ kind: "team", key: team.key }),
    ),
    ...scope.projects.map((project) =>
      linearRootPath({ kind: "project", id: project.id }),
    ),
  ]
}

type LinearFetchRoot = {
  scope: ParsedLinearRepoConfig["scopes"][number]
  /** "exclude" when one scope of the root excludes customer requests. */
  customerRequests: "exclude" | "limited"
  /** The roots that receive the walk's files. A team key can differ between Workspace files. */
  paths: string[]
}

/** One mirror walk for each distinct team and project of the union of scopes. */
export function linearFetchRoots(
  scopes: readonly LinearSourceScope[],
): LinearFetchRoot[] {
  const roots = new Map<string, LinearFetchRoot>()
  for (const scope of scopes) {
    const add = (
      key: string,
      rootScope: LinearFetchRoot["scope"],
      path: string,
    ): void => {
      const root = roots.get(key) ?? {
        scope: rootScope,
        customerRequests: "limited",
        paths: [],
      }
      if (!root.paths.includes(path)) root.paths.push(path)
      if (scope.customerRequests === "exclude")
        root.customerRequests = "exclude"
      roots.set(key, root)
    }
    for (const team of scope.teams)
      add(
        `team:${team.id}`,
        {
          externalId: team.id,
          type: "team",
          title: team.name ?? team.key,
          url: null,
          parentExternalId: null,
          teamId: team.id,
          teamKey: team.key,
        },
        linearRootPath({ kind: "team", key: team.key }),
      )
    for (const project of scope.projects)
      add(
        `project:${project.id}`,
        {
          externalId: project.id,
          type: "project",
          title: project.name ?? project.id,
          url: null,
          parentExternalId: null,
          teamId: null,
          teamKey: null,
        },
        linearRootPath({ kind: "project", id: project.id }),
      )
  }
  return [...roots.values()]
}

/**
 * The part of a Linear webhook that routes it to sources: the teams and
 * projects that the changed entity belongs to. Empty lists mean "not known",
 * and then every source of the connection syncs.
 */
export const linearSourceEventSchema = z.object({
  teamIds: z.array(z.string()),
  projectIds: z.array(z.string()),
})
export type LinearSourceEvent = z.infer<typeof linearSourceEventSchema>

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function strings(...values: unknown[]): string[] {
  return values.flatMap((value) =>
    typeof value === "string" && value
      ? [value]
      : Array.isArray(value)
        ? value.filter(
            (item): item is string => typeof item === "string" && !!item,
          )
        : [],
  )
}

/** Read the team and project ids from a verified Linear webhook payload. */
export function linearSourceEventFromPayload(
  payload: Record<string, unknown>,
): LinearSourceEvent {
  const data = record(payload.data) ?? {}
  const issue = record(data.issue) ?? {}
  const project = record(data.project) ?? {}
  const type = payload.type
  return {
    teamIds: [
      ...new Set(
        strings(
          type === "Team" ? data.id : undefined,
          data.teamId,
          data.teamIds,
          issue.teamId,
          project.teamIds,
        ),
      ),
    ],
    projectIds: [
      ...new Set(
        strings(
          type === "Project" ? data.id : undefined,
          data.projectId,
          issue.projectId,
          project.id,
        ),
      ),
    ],
  }
}

export function linearEventMatches(
  event: unknown,
  scope: LinearSourceScope,
): boolean {
  const parsed = linearSourceEventSchema.safeParse(event)
  if (!parsed.success) return true
  const { teamIds, projectIds } = parsed.data
  if (!teamIds.length && !projectIds.length) return true
  return (
    scope.teams.some((team) => teamIds.includes(team.id)) ||
    scope.projects.some((project) => projectIds.includes(project.id))
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
  const files: GitFileChange[] = []
  for (const root of linearFetchRoots(input.scopes)) {
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
  matchesEvent: ({ event, scope }) =>
    linearEventMatches(event, linearScopeSchema.parse(scope)),
}
