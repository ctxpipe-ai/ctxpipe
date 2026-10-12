import { withOrgDbContext } from "../../db/client.js"
import type { SourceMigrationHook } from "../../domain/workspace-sources/migration-plan.js"
import { listSlackConnectionsForOrg } from "../../models/slack-connector.js"

/**
 * The Slack connection before ADR-050 captured threads on `@mention` into
 * one repository. It had no channel scope (ADR-025), so no source entry
 * comes from it: the report names each connection, and a Workspace adds a
 * Slack source with its channels in settings. The mention capture is not a
 * source and stays on, so there is no `disableLegacy`.
 */
export const slackSourceMigrationHook: SourceMigrationHook = {
  provider: "slack",
  async listLegacyBindings({ orgId }) {
    const connections = await withOrgDbContext(orgId, () =>
      listSlackConnectionsForOrg(orgId),
    )
    return connections.map((connection) => ({
      provider: "slack" as const,
      connectionId: connection.id,
      unmapped:
        "Slack had no channel scope before (it captures threads on @mention); add a Slack source with channels in the Workspace settings",
    }))
  },
}
