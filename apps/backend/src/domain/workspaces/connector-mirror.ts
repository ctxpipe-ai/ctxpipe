import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { getPagerdutyBindingWithRepoByConnectionId } from "../../models/pagerduty-connector.js"
import { getSlackBindingWithRepoByConnectionId } from "../../models/slack-connector.js"
import {
  type GitPack,
  nativeGit,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import type {
  ConfiguredConnectorMirrorSource,
  ConnectorMirrorSource,
} from "./connector-mirror-input.js"
import { isLinkedRepositoryDeclaration } from "./layout.js"
import { declaresLinkedRepository } from "./link-declarations.js"
import type { WorkspaceRevision } from "./revision.js"

export type {
  ConfiguredConnectorMirrorSource,
  ConnectorMirrorSource,
} from "./connector-mirror-input.js"

import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** Read existing connector control-plane bindings; never resolve provider credentials here. */
export async function assertConnectorMirrorBinding(
  orgId: string,
  source:
    | { provider: "github" }
    | Pick<
        ConfiguredConnectorMirrorSource,
        "provider" | "connectionId" | "repositoryId"
      >,
  revision: WorkspaceRevision,
): Promise<void> {
  // GitHub has no binding; assertConnectorMirrorScope checks the link.
  if (source.provider === "github") return
  const bindingReaders = {
    linear: getLinearBindingWithRepoByConnectionId,
    notion: getNotionBindingWithRepoByConnectionId,
    slack: getSlackBindingWithRepoByConnectionId,
    confluence: getConfluenceSyncTargetWithRepoByConnectionId,
    pagerduty: getPagerdutyBindingWithRepoByConnectionId,
  }
  const binding = await bindingReaders[source.provider](
    orgId,
    source.connectionId,
  )
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

/** Validate the activated scope without retaining credentials or provider state. */
export async function assertConnectorMirrorScope(
  source: ConnectorMirrorSource,
  pack: GitPack,
): Promise<void> {
  if (source.provider === "github") {
    // Unlinking is the GitHub scope change: a mirror never lands after it.
    const files = await readGitFiles(pack, isLinkedRepositoryDeclaration)
    if (!declaresLinkedRepository(files, source.gitUrl))
      throw new Error(
        "GitHub repository is no longer linked to this Workspace; discard this capture",
      )
    return
  }
  await withGitDirectory(
    pack.sha,
    async (directory) => {
      const entry = (
        await nativeGit(directory, [
          "ls-tree",
          pack.sha,
          "--",
          `${source.provider}/config.yaml`,
        ])
      )
        .toString()
        .trim()
      const blobSha = entry ? entry.split(/\s+/)[2] : null
      if (blobSha !== source.configBlobSha)
        throw new Error(
          "Connector scope changed; discard this capture and sync the current config",
        )
    },
    pack,
  )
}
