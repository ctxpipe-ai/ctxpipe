import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { listOrgWorkspaces } from "../../models/workspaces.js"
import {
  nativeGit,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import {
  assertConnectorMirrorBinding,
  type ConnectorMirrorSource,
} from "./connector-mirror.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** Capture the existing target's immutable tree before fetching provider content. */
export async function captureConnectorMirrorTarget(input: {
  orgId: string
  contentSyncGeneration?: number
  mirror: Omit<ConnectorMirrorSource, "configBlobSha">
  env: Env
  repositoryGitUrl: string
}) {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: input.orgId } },
  })
  if (!org) throw new Error("Organization not found")
  return withOrgIdContext(org, async () => {
    const [connection] = await withOrgDbContext(input.orgId, (db) =>
      db
        .select({ contentSyncGeneration: connections.contentSyncGeneration })
        .from(connections)
        .where(eq(connections.id, input.mirror.connectionId)),
    )
    if (!connection) throw new Error("Connector connection is missing")
    if (
      input.contentSyncGeneration != null &&
      input.contentSyncGeneration !== connection.contentSyncGeneration
    )
      throw new Error("Connector config activation changed")
    const workspace = (await listOrgWorkspaces(input.orgId)).find(
      (row) =>
        normalizeWorkspaceRepositoryUrl(row.workspaceRepositoryUrl) ===
        normalizeWorkspaceRepositoryUrl(input.repositoryGitUrl),
    )
    if (!workspace) throw new Error("Connector target has no Workspace")
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: workspace.id,
      env: input.env,
      refresh: true,
    })
    if (!resolved) throw new Error("Connector target has no committed revision")
    const revision = { ...resolved.revision, access: "write-default" as const }
    await assertConnectorMirrorBinding(input.orgId, input.mirror, revision)
    const pack = await readGitPackFromRemote({
      url: revision.remote.url,
      sha: revision.sha,
      token: resolved.token,
    })
    return withGitDirectory(
      pack.sha,
      async (directory) => {
        const paths = (
          await nativeGit(directory, [
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            pack.sha,
          ])
        )
          .toString()
          .split("\0")
          .filter(Boolean)
        const configPath = `${input.mirror.provider}/config.yaml`
        const config = paths.includes(configPath)
          ? (
              await nativeGit(directory, ["show", `${pack.sha}:${configPath}`])
            ).toString()
          : undefined
        return {
          contentSyncGeneration: connection.contentSyncGeneration,
          workspaceId: workspace.id,
          revision,
          mirror: {
            ...input.mirror,
            configBlobSha: paths.includes(configPath)
              ? (
                  await nativeGit(directory, [
                    "rev-parse",
                    `${pack.sha}:${configPath}`,
                  ])
                )
                  .toString()
                  .trim()
              : null,
          },
          paths,
          config,
        }
      },
      pack,
    )
  })
}
