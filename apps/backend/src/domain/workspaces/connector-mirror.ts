import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { getPagerdutyBindingWithRepoByConnectionId } from "../../models/pagerduty-connector.js"
import { getRepositoryForOrg } from "../../models/repositories.js"
import { getSlackBindingWithRepoByConnectionId } from "../../models/slack-connector.js"
import {
  type GitPack,
  nativeGit,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import type { ConnectorMirrorSource } from "./connector-mirror-input.js"
import { isLinkedRepositoryDeclaration } from "./layout.js"
import { declaresLinkedRepository } from "./link-declarations.js"
import type { WorkspaceRevision } from "./revision.js"

export type { ConnectorMirrorSource } from "./connector-mirror-input.js"

import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/**
 * Read existing connector control-plane bindings; never resolve provider credentials here.
 * GitHub has no binding: its source is the linked repository's org row, and
 * {@link assertConnectorMirrorScope} checks the Workspace still links it.
 */
export async function assertConnectorMirrorBinding(
  orgId: string,
  source: Pick<
    ConnectorMirrorSource,
    "provider" | "connectionId" | "repositoryId"
  >,
  revision: WorkspaceRevision,
): Promise<void> {
  if (source.provider === "github") {
    const repository = await getRepositoryForOrg(orgId, source.repositoryId)
    if (repository?.githubConnectionId !== source.connectionId)
      throw new Error("Connector mirror binding changed")
    return
  }
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

/** Whether the Workspace tree in `pack` declares `gitUrl` as a linked repository. */
export async function workspaceLinksRepository(
  pack: GitPack,
  gitUrl: string,
): Promise<boolean> {
  return declaresLinkedRepository(
    await readGitFiles(pack, isLinkedRepositoryDeclaration),
    gitUrl,
  )
}

/** Validate the activated scope without retaining credentials or provider state. */
export async function assertConnectorMirrorScope(
  orgId: string,
  source: ConnectorMirrorSource,
  pack: GitPack,
): Promise<void> {
  if (source.provider === "github") {
    // Unlinking is the GitHub scope change: a mirror never lands after it.
    const repository = await getRepositoryForOrg(orgId, source.repositoryId)
    if (
      !repository ||
      !(await workspaceLinksRepository(pack, repository.gitUrl))
    )
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
