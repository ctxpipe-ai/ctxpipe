import { configBoundRepositoryUrl } from "../../domain/workspace-sources/legacy-handover.js"
import type {
  LegacySourceBinding,
  SourceMigrationHook,
} from "../../domain/workspace-sources/migration-plan.js"
import { linearScopeSchema } from "../../domain/workspace-sources/providers/linear.js"
import {
  disableLinearLegacyBinding,
  getLinearBindingWithRepoByConnectionId,
  listLinearConnectionsForOrg,
} from "../../models/linear-connector.js"
import {
  getFileContent,
  workspaceRootPathOfRepository,
} from "../github/installation-write-client.js"
import { LINEAR_CONFIG_PATH } from "./config-from-repo.js"
import { parseLinearConfigYamlContent } from "./config-yaml.js"

/**
 * Turn the old `linear/config.yaml` of one connection into a source binding
 * (ADR-050). Teams and projects move. Documents and initiatives do not,
 * because a Linear source holds teams and projects only; the report names
 * them.
 */
export function linearLegacyBindings(input: {
  connectionId: string
  /** The Linear workspace id of the connection (not a ctx| Workspace). */
  linearWorkspaceId: string | null
  syncRepositoryUrl: string
  configYaml: string | undefined
}): LegacySourceBinding[] {
  const base = { provider: "linear" as const, connectionId: input.connectionId }
  const config = parseLinearConfigYamlContent(input.configYaml)
  if (!config)
    return [
      {
        ...base,
        unmapped:
          "The sync repository has no valid linear/config.yaml on its branch",
      },
    ]
  if (input.linearWorkspaceId && config.workspaceId !== input.linearWorkspaceId)
    return [
      {
        ...base,
        unmapped:
          "linear/config.yaml names another Linear workspace than the connection",
      },
    ]
  const bindings: LegacySourceBinding[] = []
  const left = config.scopes.filter(
    (scope) =>
      scope.type === "document" ||
      scope.type === "initiative" ||
      (scope.type === "team" && !scope.teamKey),
  )
  if (left.length)
    bindings.push({
      ...base,
      unmapped: `Not moved (a Linear source holds teams and projects with a team key): ${left
        .map((scope) => `${scope.type} "${scope.title}"`)
        .join(", ")}`,
    })
  const teams = config.scopes.flatMap((item) =>
    item.type === "team" && item.teamKey ? [item.teamKey] : [],
  )
  const projects = config.scopes.flatMap((item) =>
    item.type === "project" ? [item.externalId] : [],
  )
  const scope = linearScopeSchema.safeParse({
    ...(teams.length ? { teams } : {}),
    ...(projects.length ? { projects } : {}),
    ...(config.customerRequests === "exclude"
      ? { customerRequests: "exclude" }
      : {}),
  })
  bindings.push(
    scope.success
      ? {
          ...base,
          syncRepositoryUrl: input.syncRepositoryUrl,
          scope: scope.data,
        }
      : {
          ...base,
          unmapped: `linear/config.yaml has no team or project that maps: ${scope.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        },
  )
  return bindings
}

export const linearSourceMigrationHook: SourceMigrationHook = {
  provider: "linear",
  async listLegacyBindings({ orgId, env }) {
    const connections = await listLinearConnectionsForOrg(orgId, env)
    const bindings: LegacySourceBinding[] = []
    for (const connection of connections) {
      const base = { provider: "linear" as const, connectionId: connection.id }
      const target = await getLinearBindingWithRepoByConnectionId(
        orgId,
        connection.id,
      )
      if (!target?.githubConnectionId) {
        bindings.push({
          ...base,
          unmapped: "The connection has no sync repository",
        })
        continue
      }
      const configYaml = await getFileContent({
        orgId,
        env,
        repositoryName: target.repositoryName,
        githubConnectionId: target.githubConnectionId,
        branch: target.branch,
        path: LINEAR_CONFIG_PATH,
        rootPath: await workspaceRootPathOfRepository({
          orgId,
          repositoryName: target.repositoryName,
        }),
      })
      bindings.push(
        ...linearLegacyBindings({
          connectionId: connection.id,
          linearWorkspaceId: connection.workspaceId ?? null,
          syncRepositoryUrl: target.repositoryGitUrl,
          configYaml,
        }),
      )
    }
    return bindings
  },
  async disableLegacy(input) {
    await disableLinearLegacyBinding(input)
  },
  legacyRepositoryUrl: configBoundRepositoryUrl,
}
