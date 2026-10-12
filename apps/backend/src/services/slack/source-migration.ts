import { withOrgDbContext } from "../../db/client.js"
import type {
  LegacySourceBinding,
  SourceMigrationHook,
} from "../../domain/workspace-sources/migration-plan.js"
import {
  disableSlackLegacyBinding,
  getSlackBindingWithRepoByConnectionId,
  listSlackConnectionsForOrg,
} from "../../models/slack-connector.js"
import { listFilesInTree } from "../github/installation-write-client.js"

/** The channel id of a capture path: `slack/channels/<slug>--<id>/…`. */
const CAPTURED_CHANNEL = /^slack\/channels\/[^/]*--([CG][A-Z0-9]{2,31})\//

/**
 * Turn the captures of one connection into a source binding (ADR-050).
 * Before ADR-050 the mention capture wrote each thread into one bound
 * repository and had no channel list, so the channels come from the
 * captured threads in that repository.
 */
export function slackLegacyBindings(input: {
  connectionId: string
  syncRepositoryUrl: string
  /** The file paths of the bound repository. */
  paths: readonly string[]
}): LegacySourceBinding[] {
  const base = { provider: "slack" as const, connectionId: input.connectionId }
  const channels = [
    ...new Set(
      input.paths.flatMap((path) => CAPTURED_CHANNEL.exec(path)?.[1] ?? []),
    ),
  ].sort()
  if (!channels.length)
    return [
      {
        ...base,
        unmapped:
          "The bound repository has no captured Slack threads; add a Slack source with channels in the Workspace settings",
      },
    ]
  return [
    {
      ...base,
      syncRepositoryUrl: input.syncRepositoryUrl,
      scope: { channels },
    },
  ]
}

export const slackSourceMigrationHook: SourceMigrationHook = {
  provider: "slack",
  async listLegacyBindings({ orgId, env }) {
    const connections = await withOrgDbContext(orgId, () =>
      listSlackConnectionsForOrg(orgId),
    )
    const bindings: LegacySourceBinding[] = []
    for (const connection of connections) {
      const target = await getSlackBindingWithRepoByConnectionId(
        orgId,
        connection.id,
      )
      if (!target?.githubConnectionId) {
        bindings.push({
          provider: "slack",
          connectionId: connection.id,
          unmapped: "The connection has no capture repository",
        })
        continue
      }
      const files = await listFilesInTree({
        orgId,
        env,
        repositoryName: target.repositoryName,
        githubConnectionId: target.githubConnectionId,
        branch: target.branch,
      })
      bindings.push(
        ...slackLegacyBindings({
          connectionId: connection.id,
          syncRepositoryUrl: target.repositoryGitUrl,
          paths: files.map((file) => file.path),
        }),
      )
    }
    return bindings
  },
  async disableLegacy(input) {
    await disableSlackLegacyBinding(input)
  },
}
