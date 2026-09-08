import { z } from "zod"
import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { getSlackBindingWithRepoByConnectionId } from "../../models/slack-connector.js"
import {
  gitFileChangeSchema,
  repositoryFilePathSchema,
} from "../../services/git/file-change.js"
import {
  type GitPack,
  nativeGit,
  withGitDirectory,
} from "../../services/git/pack.js"
import type { WorkspaceRevision } from "./revision.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

export const connectorMirrorSourceSchema = z
  .object({
    provider: z.enum(["linear", "notion", "slack", "confluence"]),
    connectionId: z.string().min(1),
    repositoryId: z.string().min(1),
    configBlobSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
  })
  .strict()
export type ConnectorMirrorSource = z.infer<typeof connectorMirrorSourceSchema>

const bindingReaders = {
  linear: getLinearBindingWithRepoByConnectionId,
  notion: getNotionBindingWithRepoByConnectionId,
  slack: getSlackBindingWithRepoByConnectionId,
  confluence: getConfluenceSyncTargetWithRepoByConnectionId,
}

export const connectorMirrorContentSchema = z
  .object({
    mirror: connectorMirrorSourceSchema,
    files: z.array(gitFileChangeSchema),
    deletePaths: z.array(repositoryFilePathSchema),
  })
  .strict()
  .refine(
    (input) =>
      [...input.files.map((file) => file.path), ...input.deletePaths].every(
        (path) =>
          path.startsWith(`${input.mirror.provider}/`) &&
          path !== `${input.mirror.provider}/config.yaml`,
      ),
    "A mirror may only change content under its managed provider root",
  )
  .refine(
    (input) =>
      new Set([...input.files.map((file) => file.path), ...input.deletePaths])
        .size ===
      input.files.length + input.deletePaths.length,
    "Each mirror path must have exactly one operation",
  )

/** Read existing connector control-plane bindings; never resolve provider credentials here. */
export async function assertConnectorMirrorBinding(
  orgId: string,
  source: Pick<
    ConnectorMirrorSource,
    "provider" | "connectionId" | "repositoryId"
  >,
  revision: WorkspaceRevision,
): Promise<void> {
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
