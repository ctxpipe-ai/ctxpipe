import {
  FeatureNotAccessibleLinearError,
  ForbiddenLinearError,
  InvalidInputLinearError,
} from "@linear/sdk"

import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import type {
  SourceAdapter,
  SourceFetchResult,
} from "../../domain/workspace-sources/adapter.js"
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
import { log } from "../../observability/logger.js"
import type { GitFileChange } from "../git/file-change.js"
import { omitUnchangedLinearFiles } from "./assets.js"
import {
  discoverLinearScopes,
  type LinearTokenRefreshHandler,
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
  withLinearClient,
} from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import {
  collectLinearMirrorPages,
  fetchLinearMirrorPage,
  walkLinearMirrorPages,
} from "./content.js"
import { buildLinearIncrementalChanges } from "./incremental.js"
import { loadProject } from "./read.js"
import { linearEventMatches, linearSourceEventSchema } from "./source-event.js"
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

function linearManagedPaths(scope: LinearSourceScope): string[] {
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
 * that Linear does not know has no root; it is in `unknownTeams`.
 */
function linearFetchRoots(
  scopes: readonly LinearSourceScope[],
  teamIdByKey: ReadonlyMap<string, string>,
): { roots: LinearFetchRoot[]; unknownTeams: string[] } {
  const roots = new Map<string, LinearFetchRoot>()
  const unknownTeams = new Set<string>()
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
      if (!teamId) {
        unknownTeams.add(key)
        continue
      }
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
  return { roots: [...roots.values()], unknownTeams: [...unknownTeams] }
}

function tokenRefresher(input: {
  orgId: string
  connectionId: string
  env: Env
}): LinearTokenRefreshHandler {
  return (expectedRefreshToken, expectedAccessToken) =>
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
    })
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

/** Linear refused the entity for good: it does not exist, or the grant cannot read it. */
function isPermanentLinearError(error: unknown): boolean {
  return (
    error instanceof InvalidInputLinearError ||
    error instanceof ForbiddenLinearError ||
    error instanceof FeatureNotAccessibleLinearError ||
    (error instanceof Error && /entity not found/i.test(error.message))
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const missingTeamsDetail = (keys: readonly string[]) =>
  `The Linear workspace has no team with the key ${keys.join(", ")}`

/**
 * Name the team keys and project ids of a scope that Linear does not have.
 * A transient Linear failure does not hide a "not found" that Linear gave
 * for another item; when Linear gives no answer, the scope counts as in
 * reach and the sync reports a later failure.
 */
async function checkLinearSourceAccess(input: {
  orgId: string
  connectionId: string
  scope: LinearSourceScope
  env: Env
}): Promise<string | null> {
  const problems: string[] = []
  let connection: LinearConnection
  try {
    connection = await loadInstalledConnection(input)
  } catch (error) {
    log.warn({
      step: "linear.source_access_check",
      connectionId: input.connectionId,
      message: message(error),
    })
    return null
  }
  const onTokenRefresh = tokenRefresher(input)
  const teams = linearTeams(input.scope)
  if (teams.length) {
    try {
      const teamIdByKey = await linearTeamIdsByKey({
        env: input.env,
        connection,
        onTokenRefresh,
      })
      const missing = teams.filter((key) => !teamIdByKey.has(key.toUpperCase()))
      if (missing.length) problems.push(missingTeamsDetail(missing))
    } catch (error) {
      log.warn({
        step: "linear.source_access_check",
        connectionId: input.connectionId,
        message: message(error),
      })
    }
  }
  const missingProjects: string[] = []
  for (const id of linearProjects(input.scope)) {
    try {
      await withLinearClient(
        { env: input.env, connection, onTokenRefresh },
        (client) =>
          loadProject(client, connection.accessToken ?? "", id, {
            includeNeeds: false,
            includeDocuments: false,
          }),
      )
    } catch (error) {
      if (isPermanentLinearError(error)) missingProjects.push(id)
      else
        log.warn({
          step: "linear.source_access_check",
          connectionId: input.connectionId,
          message: message(error),
        })
    }
  }
  if (missingProjects.length)
    problems.push(
      `Linear has no project that this connection can read with the id ${missingProjects.join(", ")}`,
    )
  return problems.length ? problems.join("; ") : null
}

/** The managed files under one root, at the paths that the mirror walk uses. */
function existingForRoot(
  root: LinearFetchRoot,
  existing: ReadonlyArray<{ path: string; sha: string | null }>,
): { paths: string[]; blobs: Array<{ path: string; sha: string }> } {
  const shas = new Map<string, string | null>()
  const counts = new Map<string, number>()
  for (const prefix of root.paths)
    for (const file of existing) {
      if (!file.path.startsWith(prefix)) continue
      const local = `linear/${file.path.slice(prefix.length)}`
      counts.set(local, (counts.get(local) ?? 0) + 1)
      const before = shas.get(local)
      shas.set(
        local,
        before === undefined || before === file.sha ? file.sha : null,
      )
    }
  return {
    paths: [...shas.keys()],
    blobs: [...shas].flatMap(([path, sha]) =>
      sha && counts.get(path) === root.paths.length ? [{ path, sha }] : [],
    ),
  }
}

/** The files of one root, at mirror walk paths. */
type RootContent = {
  files: GitFileChange[]
  deletePaths: string[]
  /** Some entities failed: write the files, delete nothing. */
  partial: boolean
}

const ROOT_ATTEMPTS = 3

async function readRoot(input: {
  root: LinearFetchRoot
  config: ParsedLinearRepoConfig
  connection: () => Promise<LinearConnection>
  env: Env
  onTokenRefresh: LinearTokenRefreshHandler
  event: ReturnType<typeof linearSourceEventSchema.safeParse>["data"]
  existing: { paths: string[]; blobs: Array<{ path: string; sha: string }> }
  incremental: boolean
}): Promise<RootContent> {
  const { config } = input
  const existingShaByPath = new Map(
    input.existing.blobs.map((blob) => [blob.path, blob.sha]),
  )
  if (input.incremental && input.event?.entity) {
    const changes = await buildLinearIncrementalChanges({
      env: input.env,
      connection: await input.connection(),
      config,
      entities: [input.event.entity],
      existingPaths: input.existing.paths,
      existingShaByPath,
      onTokenRefresh: input.onTokenRefresh,
    })
    return {
      files: omitUnchangedLinearFiles(changes.files, input.existing.blobs),
      deletePaths: changes.deletePaths,
      partial: changes.failures.length > 0,
    }
  }
  const pages = await walkLinearMirrorPages({
    config,
    runPage: async (_name, request) =>
      fetchLinearMirrorPage({
        env: input.env,
        connection: await input.connection(),
        config,
        onTokenRefresh: input.onTokenRefresh,
        request,
      }),
  })
  const collected = collectLinearMirrorPages(pages)
  const captured = await captureLinearContent({
    env: input.env,
    connection: await input.connection(),
    files: collected.files,
    failures: collected.failures,
    existingPaths: input.existing.paths,
    existingBlobs: input.incremental ? input.existing.blobs : undefined,
    onTokenRefresh: input.onTokenRefresh,
  })
  if (captured.status === "failed")
    throw new Error(
      `Linear ${input.root.scope.type} ${input.root.scope.externalId} gave no content`,
    )
  return {
    files: captured.files,
    deletePaths: captured.deletePaths,
    partial: captured.status === "partial_failed",
  }
}

/**
 * Fetch the union of Linear scopes: one mirror walk for each team and each
 * project, with the page cursors of the existing mirror (ADR-022). Each
 * root is separate: a root that fails keeps its files and does not stop the
 * other roots. A root that Linear refuses for good (not found, no access)
 * is reported as unreachable, so that its sources show the reason. With the
 * Workspace blobs, the result is a patch: unchanged files are left out, and
 * a webhook entity uses the incremental mirror.
 */
async function fetchLinearSources(input: {
  orgId: string
  connectionId: string
  scopes: readonly LinearSourceScope[]
  env: Env
  event?: unknown
  existing?: ReadonlyArray<{ path: string; sha: string | null }>
}): Promise<SourceFetchResult> {
  const onTokenRefresh = tokenRefresher(input)
  const first = await loadInstalledConnection(input)
  const workspace = linearWorkspaceIdentity(first)
  const event = linearSourceEventSchema.safeParse(input.event).data
  const incremental = input.existing !== undefined
  const result: Required<
    Pick<SourceFetchResult, "keepPaths" | "unreachable">
  > & { files: GitFileChange[]; deletePaths: string[] } = {
    files: [],
    keepPaths: [],
    unreachable: [],
    deletePaths: [],
  }
  const teamKeys = input.scopes.flatMap((scope) => linearTeams(scope))
  let teamIdByKey = new Map<string, string>()
  if (teamKeys.length)
    try {
      teamIdByKey = await linearTeamIdsByKey({
        env: input.env,
        connection: first,
        onTokenRefresh,
      })
    } catch (error) {
      // Without the team list, no team root can sync in this cycle.
      log.warn({
        step: "linear.source_fetch_teams",
        connectionId: input.connectionId,
        message: message(error),
      })
      for (const key of teamKeys)
        result.keepPaths.push(linearRootPath({ kind: "team", key }))
    }
  const { roots, unknownTeams } = linearFetchRoots(input.scopes, teamIdByKey)
  if (teamIdByKey.size)
    for (const key of unknownTeams)
      result.unreachable.push({
        path: linearRootPath({ kind: "team", key }),
        status: "out_of_access",
        detail: missingTeamsDetail([key]),
      })
  for (const root of roots) {
    const config: ParsedLinearRepoConfig = {
      ...workspace,
      customerRequests: root.customerRequests,
      scopes: [root.scope],
    }
    let content: RootContent | undefined
    for (let attempt = 1; attempt <= ROOT_ATTEMPTS && !content; attempt++) {
      try {
        content = await readRoot({
          root,
          config,
          connection: () => loadInstalledConnection(input),
          env: input.env,
          onTokenRefresh,
          event,
          existing: existingForRoot(root, input.existing ?? []),
          incremental,
        })
        if (content.partial && !incremental && attempt < ROOT_ATTEMPTS)
          content = undefined
      } catch (error) {
        if (isPermanentLinearError(error)) {
          for (const path of root.paths)
            result.unreachable.push({
              path,
              status: "out_of_access",
              detail: `Linear refused ${root.scope.type} ${root.scope.teamKey ?? root.scope.externalId}: ${message(error)}`,
            })
          break
        }
        log.warn({
          step: "linear.source_fetch_root",
          connectionId: input.connectionId,
          root: root.paths.join(","),
          attempt,
          message: message(error),
        })
      }
    }
    // A failed root, or a partial one without a patch, keeps its files.
    if (!content || (content.partial && !incremental)) {
      if (!result.unreachable.some((lost) => root.paths.includes(lost.path)))
        result.keepPaths.push(...root.paths)
      continue
    }
    for (const file of [...content.files, ...content.deletePaths]) {
      const path = typeof file === "string" ? file : file.path
      if (!path.startsWith("linear/"))
        throw new Error(`Linear file ${path} is outside linear/`)
    }
    for (const path of root.paths) {
      const at = (local: string) => `${path}${local.slice("linear/".length)}`
      result.files.push(
        ...content.files.map((file) => ({ ...file, path: at(file.path) })),
      )
      if (!content.partial)
        result.deletePaths.push(...content.deletePaths.map(at))
    }
  }
  return incremental
    ? result
    : {
        files: result.files,
        keepPaths: result.keepPaths,
        unreachable: result.unreachable,
      }
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
