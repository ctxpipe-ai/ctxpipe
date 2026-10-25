import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { log } from "../../observability/logger.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { repositoryFilePathSchema } from "../../services/git/file-change.js"
import {
  packRootTree,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { resolveWorkspaceReadRevision } from "../workspaces/resolve-revision.js"
import { workspaceRootPath } from "../workspaces/root-path.js"
import { listExistingBlobs } from "./existing-blobs.js"
import { refusedSliceFile, refuseMirrorPath } from "./mirror-path.js"
import { diffSlice } from "./slice-diff.js"
import { readSliceTarget } from "./slice-target.js"
import type { ExistingBlob, StampOwner, WorkspaceSliceWrite } from "./sync.js"

/**
 * The production slice writer: read the Workspace head, drop the write when
 * the sources changed after the rows' revision, and queue one connector
 * mirror commit fenced by the sources fence id (`sourcesFenceAt`: the
 * `sources/` tree and `.ctxpipe/sources.yaml`). A cleanup is fenced only on
 * its removed targets: the head sources must not have them.
 */
export async function writeWorkspaceSlice(
  write: WorkspaceSliceWrite,
  env: Env,
): Promise<{ queued: boolean }> {
  // Each changed path must be safe and under a path that this write owns:
  // another source of the Workspace owns the other paths of the provider.
  // A delete names an existing path, so it needs only a valid repository
  // path and the owned prefix: a `.gitkeep` or an older non-NFC name must
  // be deletable. A write also needs a safe mirror path.
  const owns = (path: string) =>
    write.ownedPrefixes.some((prefix) => path.startsWith(prefix))
  for (const path of write.files.map((file) => file.path)) {
    const unsafe = refusedSliceFile(path, write.ownedPrefixes)
    if (unsafe)
      refuseMirrorPath({ provider: write.provider, path, reason: unsafe })
  }
  for (const path of write.deletePaths ?? []) {
    const unsafe = !repositoryFilePathSchema.safeParse(path).success
      ? "is not a repository file path"
      : owns(path)
        ? null
        : "is not under a path that the write owns"
    if (unsafe)
      refuseMirrorPath({ provider: write.provider, path, reason: unsafe })
  }
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

      removed: write.removed,
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
          ...(write.removed
            ? { removedTargets: write.removed }
            : { sourcesBlobSha: captured.sourcesBlobSha }),
        },
        // A regular file, also where the head has a symlink at the path.
        mergeFiles: change.files.map((file) => ({
          ...file,
          mode: "100644" as const,
        })),
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
  /** The managed paths to read, with the source path stamped there. */
  owners: readonly StampOwner[]
}): Promise<ExistingBlob[]> {
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
      async (directory) => {
        const tree = await packRootTree(directory, pack)
        return tree ? listExistingBlobs(directory, tree, input.owners) : []
      },
      pack,
      null,
    )
  })
}
