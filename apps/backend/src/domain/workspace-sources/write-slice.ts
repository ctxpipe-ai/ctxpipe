import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { resolveWorkspaceReadRevision } from "../workspaces/resolve-revision.js"
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
    })
  })
  // The next projection plans a new write from the changed sources file.
  if (!captured?.fresh) return { queued: false }
  const change = diffSlice(write, captured.paths)
  if (!change.files.length && !change.deletePaths.length)
    return { queued: false }
  const admitted = await enqueueWorkspaceWriteCommit(
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
    getLogger(),
  )
  return { queued: admitted.started }
}
