import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb } from "../db/client.js"
import { githubSourcePathOf } from "../domain/workspace-sources/github-sources.js"
import { stampMirrorFiles } from "../domain/workspace-sources/stamp-sources.js"
import { readWorkspaceBlobs } from "../domain/workspace-sources/write-slice.js"
import { resolveWorkspaceReadRevision } from "../domain/workspaces/resolve-revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"
import { findRepositoriesByNormalizedGitUrls } from "../models/repositories.js"
import { listWorkspaceSourceRows } from "../models/workspace-sources.js"
import { getLogger } from "../observability/logger.js"
import type { GithubMirrorFile } from "../services/github/github-mirror.js"
import {
  type RepositoryIngestionChildStep,
  runConnectorRepositoryIngestionWorkflow,
} from "./enqueue-repository-ingestion.js"
import { workspaceConnectorMirror } from "./workflows/workspace-connector-mirror.js"

/** Revision to write, the connection that reads the repository, and the row to re-index. */
export async function captureGithubMirrorTarget(input: {
  orgId: string
  workspaceId: string
  gitUrl: string
  connectionId?: string
}) {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: input.orgId } },
  })
  if (!org) throw new Error("Organization not found")
  return withOrgIdContext(org, async () => {
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      env: parseEnv(process.env),
      refresh: true,
    })
    if (!resolved) return { skipped: "no_revision" as const }
    const revision = { ...resolved.revision, access: "write-default" as const }
    const connectionId = input.connectionId ?? revision.remote.connectionId
    const repository = githubRepoFullNameFromWorkspaceUrl(input.gitUrl)
    if (!connectionId || !repository) {
      getLogger().warn("github_mirror_no_source", {
        workspaceId: input.workspaceId,
        gitUrl: input.gitUrl,
      })
      return { skipped: "no_source" as const }
    }
    const [workspaceRepository] = await findRepositoriesByNormalizedGitUrls([
      revision.remote.url,
    ])
    const sourcePath = githubSourcePathOf(
      await listWorkspaceSourceRows({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      }),
      input.gitUrl,
    )
    return {
      revision,
      connectionId,
      repository,
      /** The GitHub source file of the repository; stamped into each file. */
      sourcePath,
      /** The Workspace repository's org row, re-indexed after a mirror commit. */
      workspaceRepositoryId: workspaceRepository?.id ?? null,
    }
  })
}

type GithubMirrorTarget = Exclude<
  Awaited<ReturnType<typeof captureGithubMirrorTarget>>,
  { skipped: string }
>

/** The mirror files under `prefix` with a wrong or missing stamp. */
async function readGithubMirrorStampsToWrite(input: {
  orgId: string
  workspaceId: string
  prefix: string
  sourcePath: string
}) {
  const blobs = await readWorkspaceBlobs({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    env: parseEnv(process.env),
    owners: [
      {
        prefixes: [input.prefix],
        sourcePath: input.sourcePath,
      },
    ],
  })
  return blobs.filter((blob) => blob.restamped !== undefined)
}

/**
 * Stamp the files with the source file of the repository (ADR-050), restamp
 * from Git the files under `prefix` with an older stamp, publish everything
 * as one commit, and re-index the Workspace repository. Returns the number of
 * files written. The step names stay fixed, so a replay finds its steps.
 */
export async function commitGithubMirror(
  step: RepositoryIngestionChildStep,
  input: {
    orgId: string
    workspaceId: string
    gitUrl: string
    runId: string
    target: GithubMirrorTarget
    files: GithubMirrorFile[]
    deletePaths: string[]
    /** `github/pulls/<owner>/<repo>/` or `github/issues/<owner>/<repo>/`. */
    prefix: string
    /** The indexing reason of the re-index. */
    reason: string
    stepNames: { readStamps: string; commit: string }
  },
): Promise<number> {
  const { target, deletePaths } = input
  const sourcePath = target.sourcePath
  const stamped = sourcePath
    ? stampMirrorFiles(
        input.files,
        sourcePath,
        (
          await step.run({ name: input.stepNames.readStamps }, () =>
            readGithubMirrorStampsToWrite({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              prefix: input.prefix,
              sourcePath,
            }),
          )
        ).filter((blob) => !deletePaths.includes(blob.path)),
      )
    : input.files
  if (stamped.length === 0 && deletePaths.length === 0) return 0
  await step.runWorkflow(
    workspaceConnectorMirror.spec,
    {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      revision: target.revision,
      mirror: { provider: "github", gitUrl: input.gitUrl },
      jobId: `wjob_${input.runId}_mirror`,
      files: stamped,
      deletePaths,
    },
    { name: input.stepNames.commit },
  )
  if (target.workspaceRepositoryId)
    await runConnectorRepositoryIngestionWorkflow(
      step,
      {
        orgId: input.orgId,
        repositoryId: target.workspaceRepositoryId,
        targetBranch: target.revision.defaultBranch,
        indexingReason: input.reason,
      },
      { error: (error) => getLogger().error(error) },
    )
  return stamped.length
}
