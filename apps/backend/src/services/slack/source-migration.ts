import { withOrgDbContext } from "../../db/client.js"
import { configBoundRepositoryUrl } from "../../domain/workspace-sources/legacy-handover.js"
import type {
  LegacySourceBinding,
  SourceMigrationHook,
} from "../../domain/workspace-sources/migration-plan.js"
import { SLACK_CHANNEL_ID_PATTERN } from "../../domain/workspace-sources/providers/slack.js"
import {
  disableSlackLegacyBinding,
  getSlackBindingWithRepoByConnectionId,
  listSlackConnectionsForOrg,
} from "../../models/slack-connector.js"
import { listFilesInTree } from "../github/installation-write-client.js"
import { slackSourceChannelDir } from "./converter.js"

/** The channel id of a capture path: `slack/channels/<slug>--<id>/…`. */
const CAPTURED_CHANNEL = new RegExp(
  `^slack/channels/[^/]*--(${SLACK_CHANNEL_ID_PATTERN})/`,
)

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
      // Only the bound repository has the captures, so a Workspace that
      // only links it does not get the source.
      ownRepositoryOnly: true,
    },
  ]
}

/**
 * Move each old capture `slack/channels/<slug>--<id>/…` to the managed path
 * `slack/channels/<id>/…` of its channel, by blob sha, so the threads stay
 * managed and git keeps their history. No file is read.
 */
export async function planSlackLegacyMoves(input: {
  files: ReadonlyArray<{ path: string; sha: string }>
}): Promise<Array<{ from: string; to: string; sha: string }>> {
  return input.files.flatMap((file) => {
    const match = CAPTURED_CHANNEL.exec(file.path)
    if (!match?.[1]) return []
    return [
      {
        from: file.path,
        to: `${slackSourceChannelDir(match[1])}${file.path.slice(match[0].length)}`,
        sha: file.sha,
      },
    ]
  })
}

export const slackSourceMigrationHook: SourceMigrationHook = {
  provider: "slack",
  legacyMoves: planSlackLegacyMoves,
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
  legacyRepositoryUrl: configBoundRepositoryUrl,
}
