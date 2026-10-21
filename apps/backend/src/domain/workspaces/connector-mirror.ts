import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { getPagerdutyBindingWithRepoByConnectionId } from "../../models/pagerduty-connector.js"
import { getSlackBindingWithRepoByConnectionId } from "../../models/slack-connector.js"
import {
  type GitPack,
  type GitRemoteRead,
  nativeGit,
  packRootTree,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import { githubSourceRepositories } from "../workspace-sources/github-sources.js"
import { sourcesHaveNone } from "../workspace-sources/projection-plan.js"
import {
  isSourcesTreePath,
  sourcesFenceAt,
  splitSourcesTree,
} from "../workspace-sources/source-tree.js"
import type {
  ConfiguredConnectorMirrorSource,
  ConnectorMirrorSource,
  WorkspaceSourcesMirrorSource,
} from "./connector-mirror-input.js"
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
      >
    | WorkspaceSourcesMirrorSource,
  revision: WorkspaceRevision,
): Promise<void> {
  // A Workspace source sync has no binding: the sources fence id fences it.
  if ("sourcesBlobSha" in source || "removedTargets" in source) return
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
  read?: GitRemoteRead,
): Promise<void> {
  if ("sourcesBlobSha" in source) {
    const fence = await withGitDirectory(
      pack.sha,
      (directory) => sourcesFenceAt(directory, pack),
      pack,
      read,
    )
    if (fence !== source.sourcesBlobSha)
      throw new Error(
        "Workspace sources changed; discard this capture and sync the current sources",
      )
    return
  }
  if ("removedTargets" in source) {
    const { sourcesFile, sourceFiles } = splitSourcesTree(
      await readGitFiles(pack, isSourcesTreePath, undefined, read),
    )
    if (
      !(await sourcesHaveNone(
        { text: sourcesFile, sourceFiles },
        source.removedTargets,
      ))
    )
      throw new Error(
        "A removed Workspace source is in the sources again; discard this cleanup",
      )
    return
  }
  if (source.provider === "github") {
    // Unlinking is the GitHub scope change: a mirror never lands after it.
    const { sourcesFile, sourceFiles } = splitSourcesTree(
      await readGitFiles(pack, isSourcesTreePath, undefined, read),
    )
    const target = normalizeWorkspaceRepositoryUrl(source.gitUrl)
    if (
      !githubSourceRepositories(sourcesFile, null, sourceFiles).some(
        (linked) => linked.gitUrl === target,
      )
    )
      throw new Error(
        "GitHub repository is no longer linked to this Workspace; discard this capture",
      )
    return
  }
  if (
    (await blobShaAt(pack, `${source.provider}/config.yaml`, read)) !==
    source.configBlobSha
  )
    throw new Error(
      "Connector scope changed; discard this capture and sync the current config",
    )
}

/** The blob id of root-relative `path` at the pack's commit, or null when it is absent. */
async function blobShaAt(
  pack: GitPack,
  path: string,
  read: GitRemoteRead | undefined,
): Promise<string | null> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const tree = await packRootTree(directory, pack)
      if (!tree) return null
      const entry = (await nativeGit(directory, ["ls-tree", tree, "--", path]))
        .toString()
        .trim()
      return entry ? (entry.split(/\s+/)[2] ?? null) : null
    },
    pack,
    read,
  )
}
