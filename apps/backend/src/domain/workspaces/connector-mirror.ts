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
import { githubSourceRepositories } from "../workspace-sources/github-sources.js"
import { SOURCES_FILE_PATH } from "../workspace-sources/sources-file.js"
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
  // A Workspace source sync has no binding: the sources file blob fences it.
  if ("sourcesBlobSha" in source) return
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
  if ("sourcesBlobSha" in source) {
    if ((await blobShaAt(pack, SOURCES_FILE_PATH)) !== source.sourcesBlobSha)
      throw new Error(
        "Workspace sources changed; discard this capture and sync the current sources",
      )
    return
  }
  if (source.provider === "github") {
    // Unlinking is the GitHub scope change: a mirror never lands after it.
    const [file] = await readGitFiles(
      pack,
      (path) => path === SOURCES_FILE_PATH,
    )
    const target = normalizeWorkspaceRepositoryUrl(source.gitUrl)
    if (
      !githubSourceRepositories(file?.content ?? null, null).some(
        (linked) => linked.gitUrl === target,
      )
    )
      throw new Error(
        "GitHub repository is no longer linked to this Workspace; discard this capture",
      )
    return
  }
  if (
    (await blobShaAt(pack, `${source.provider}/config.yaml`)) !==
    source.configBlobSha
  )
    throw new Error(
      "Connector scope changed; discard this capture and sync the current config",
    )
}

/** The blob id of `path` at the pack's commit, or null when it is absent. */
async function blobShaAt(pack: GitPack, path: string): Promise<string | null> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const entry = (
        await nativeGit(directory, ["ls-tree", pack.sha, "--", path])
      )
        .toString()
        .trim()
      return entry ? (entry.split(/\s+/)[2] ?? null) : null
    },
    pack,
  )
}
