import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { log } from "../../observability/logger.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import {
  listPackBlobs,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { resolveWorkspaceReadRevision } from "../workspaces/resolve-revision.js"
import { workspaceRootPath } from "../workspaces/root-path.js"
import { diffSlice } from "./slice-diff.js"
import { readSliceTarget } from "./slice-target.js"
import type { WorkspaceSliceWrite } from "./sync.js"

/**
 * The production slice writer: read the Workspace head, drop the write when
 * the sources file changed after the rows' revision, and queue one connector
 * mirror commit fenced by the blob of `.ctxpipe/sources.yaml`.
 */
export async function writeWorkspaceSlice(
  write: WorkspaceSliceWrite,
  env: Env,
): Promise<{ queued: boolean }> {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: write.orgId } },
  })
  if (!org) throw new Error("Organization not found")
  const captured = await withOrgIdContext(org, async () => {
    const resolved = await resolveWorkspaceReadRevision({
      orgId: write.orgId,
      workspaceId: write.workspaceId,
      env,
      refresh: true,
    })
    if (!resolved) return null
    return readSliceTarget({
      url: resolved.revision.remote.url,
      token: resolved.token,
      headSha: resolved.revision.sha,
      rowsRevision: write.sourcesRevision,
      root: workspaceRootPath(resolved.revision),
    })
  })
  // The next projection plans a new write from the changed sources file.
  if (!captured?.fresh) return { queued: false }
  const change = diffSlice(write, captured.paths)
  if (!change.files.length && !change.deletePaths.length)
    return { queued: false }
  // Admission reads the Workspace in the org context, as the read above.
  const admitted = await withOrgIdContext(org, () =>
    enqueueWorkspaceWriteCommit(
      {
        orgId: write.orgId,
        workspaceId: write.workspaceId,
        kind: "connector_mirror",
        mirror: {
          provider: write.provider,
          connectionId: write.connectionId,
          sourcesBlobSha: captured.sourcesBlobSha,
        },
        mergeFiles: change.files,
        mergeDeletePaths: change.deletePaths,
      },
      // The sources sync workflow has no request logger.
      {
        error: (error) =>
          log.error({
            step: "workspace_sources.write_slice",
            workspaceId: write.workspaceId,
            message: error.message,
          }),
      },
    ),
  )
  return { queued: admitted.started }
}

/**
 * The blobs of the Workspace head, for the sync to skip unchanged files.
 * Empty when the Workspace has no readable revision.
 */
export async function readWorkspaceBlobs(input: {
  orgId: string
  workspaceId: string
  env: Env
}): Promise<Array<{ path: string; sha: string }>> {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: input.orgId } },
  })
  if (!org) throw new Error("Organization not found")
  return withOrgIdContext(org, async () => {
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      env: input.env,
      refresh: true,
    })
    if (!resolved) return []
    const pack = await readGitPackFromRemote({
      url: resolved.revision.remote.url,
      sha: resolved.revision.sha,
      additionalShas: [],
      token: resolved.token,
      root: workspaceRootPath(resolved.revision),
    })
    return withGitDirectory(
      pack.sha,
      (directory) => listPackBlobs(directory, pack),
      pack,
    )
  })
}
