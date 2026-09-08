import { z } from "zod"
import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { getSlackBindingWithRepoByConnectionId } from "../../models/slack-connector.js"
import type { WorkspaceRevision } from "./revision.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

export const connectorMirrorSourceSchema = z
  .object({
    provider: z.enum(["linear", "notion", "slack", "confluence"]),
    connectionId: z.string().min(1),
    repositoryId: z.string().min(1),
  })
  .strict()
export type ConnectorMirrorSource = z.infer<typeof connectorMirrorSourceSchema>

/** Read existing connector control-plane bindings; never resolve provider credentials here. */
export async function assertConnectorMirrorBinding(
  orgId: string,
  source: ConnectorMirrorSource,
  revision: WorkspaceRevision,
): Promise<void> {
  const readers = {
    linear: getLinearBindingWithRepoByConnectionId,
    notion: getNotionBindingWithRepoByConnectionId,
    slack: getSlackBindingWithRepoByConnectionId,
    confluence: getConfluenceSyncTargetWithRepoByConnectionId,
  }
  const binding = await readers[source.provider](orgId, source.connectionId)
  if (
    !binding ||
    binding.orgId !== orgId ||
    !binding.enabled ||
    binding.repositoryId !== source.repositoryId ||
    binding.branch !== revision.defaultBranch ||
    binding.githubConnectionId !== revision.remote.connectionId ||
    normalizeWorkspaceRepositoryUrl(binding.repositoryGitUrl) !==
      normalizeWorkspaceRepositoryUrl(revision.remote.url) ||
    ("setupPhase" in binding &&
      binding.setupPhase !== "live" &&
      binding.setupPhase !== "initial_sync")
  )
    throw new Error("Connector mirror binding changed")
}
