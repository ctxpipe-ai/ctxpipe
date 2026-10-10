import { RequestError } from "octokit"
import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { generateObjectId } from "../../lib/id.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import {
  bindUnboundWorkspace,
  createWorkspace,
  listUnboundWorkspaces,
  updateWorkspace,
  type WorkspaceRecord,
} from "../../models/workspaces.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { enqueueWorkspaceTipCheck } from "../../openworkflow/enqueue-workspace-tip-check.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import {
  resolveWorkspaceGithubConnectionId,
  type WorkspaceAddSource,
} from "./bind-github-connection.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"
import { destroySandboxesForWorkspace } from "./workspace-sandbox-cleanup.js"
import {
  githubConnectionIdForWriteProbe,
  githubRepoFullNameFromWorkspaceUrl,
  writeStatusFromClassification,
} from "./write-status.js"

type WorkspaceLog = { error: (err: Error) => void }

export async function attachOrgRepository(input: {
  orgId: string
  gitUrl: string
  githubConnectionId?: string | null
  log: WorkspaceLog
}) {
  try {
    await ensureOrgRepositoryForGitUrl(input)
  } catch (error) {
    input.log.error(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function createWorkspaceLifecycle(input: {
  orgId: string
  gitUrl: string
  displayName?: string
  slug?: string
  githubConnectionId?: string | null
  source?: WorkspaceAddSource
  log: WorkspaceLog
}): Promise<WorkspaceRecord & { autoLinkGitUrls: string[] }> {
  const githubConnectionId = await resolveWorkspaceGithubConnectionId({
    orgId: input.orgId,
    requested: input.githubConnectionId,
    source: input.source,
  })
  const write = writeStatusFromClassification({
    workspaceRepositoryUrl: input.gitUrl,
    githubConnectionId,
  })
  const created = await createWorkspace({
    gitUrl: input.gitUrl,
    displayName: input.displayName,
    slug: input.slug,
    ...(githubConnectionId ? { githubConnectionId } : {}),
    write,
  })
  await attachOrgRepository({
    orgId: created.orgId,
    gitUrl: created.workspaceRepositoryUrl,
    githubConnectionId: created.githubConnectionId,
    log: input.log,
  })
  void enqueueWorkspaceHydrate(
    { orgId: created.orgId, workspaceId: created.id },
    input.log,
  )
  void enqueueWorkspaceWriteCommit(
    {
      orgId: created.orgId,
      workspaceId: created.id,
      kind: "migration_export",
    },
    input.log,
  )
  void enqueueWorkspaceWriteCommit(
    { orgId: created.orgId, workspaceId: created.id, kind: "bootstrap" },
    input.log,
  )
  for (const gitUrl of created.autoLinkGitUrls) {
    void enqueueWorkspaceWriteCommit(
      {
        orgId: created.orgId,
        workspaceId: created.id,
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: gitUrl,
      },
      input.log,
    )
  }
  void enqueueWorkspaceTipCheck(created.orgId, input.log)
  return created
}

export async function renameWorkspaceLifecycle(input: {
  orgId: string
  workspaceId: string
  displayName: string
  log: WorkspaceLog
}): Promise<boolean> {
  const jobId = generateObjectId("wjob")
  const result = await enqueueWorkspaceWriteCommit(
    {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      jobId,
      kind: "ops_folder_map",
      displayName: input.displayName,
    },
    input.log,
  )
  return (
    result.started ||
    (await reconcileWorkspaceWriteJob(jobId))?.status === "paused"
  )
}

export async function relinkWorkspaceLifecycle(input: {
  slug: string
  current: WorkspaceRecord
  orgId: string
  workspaceRepositoryUrl?: string
  githubConnectionId?: string | null
  source?: WorkspaceAddSource
  nextSlug?: string
  persistConnection: boolean
  bindingSubmitted: boolean
  log: WorkspaceLog
}): Promise<{ workspace: WorkspaceRecord | null; changed: boolean }> {
  const githubConnectionId = input.bindingSubmitted
    ? await resolveWorkspaceGithubConnectionId({
        orgId: input.orgId,
        requested: githubConnectionIdForWriteProbe({
          requested: input.githubConnectionId,
          existing: input.current.githubConnectionId,
        }),
        source: input.source,
      })
    : input.current.githubConnectionId
  const nextUrl = input.workspaceRepositoryUrl
    ? normalizeWorkspaceRepositoryUrl(input.workspaceRepositoryUrl)
    : input.current.workspaceRepositoryUrl
  const changed =
    (Boolean(nextUrl) && nextUrl !== input.current.workspaceRepositoryUrl) ||
    (input.persistConnection &&
      githubConnectionId !== input.current.githubConnectionId)
  const write = input.bindingSubmitted
    ? writeStatusFromClassification({
        workspaceRepositoryUrl: nextUrl || input.current.workspaceRepositoryUrl,
        githubConnectionId,
      })
    : undefined
  const updated = await updateWorkspace(input.slug, {
    ...(input.nextSlug !== undefined ? { slug: input.nextSlug } : {}),
    ...(input.workspaceRepositoryUrl !== undefined
      ? { workspaceRepositoryUrl: input.workspaceRepositoryUrl }
      : {}),
    ...(input.persistConnection ? { githubConnectionId } : {}),
    ...(write ? { write } : {}),
  })
  if (!updated) {
    return { workspace: null, changed: false }
  }
  if (changed) await startRelinkedWorkspace(updated, input.log)
  return { workspace: updated, changed }
}

/**
 * Bind each GitHub workspace that has no connection to a newly attached
 * connection, when its installation can read the repository. This restores
 * workspaces a disconnect detached; it also binds Paste workspaces the
 * installation covers. A failure here never fails the connection itself;
 * the workspace stays unbound and the error is logged.
 */
export async function rebindUnboundWorkspaces(input: {
  orgId: string
  connectionId: string
  env: Env
  log: WorkspaceLog
}): Promise<void> {
  const logError = (error: unknown) =>
    input.log.error(error instanceof Error ? error : new Error(String(error)))
  try {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) return
    await withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      for (const workspace of await listUnboundWorkspaces()) {
        const repoFullName = githubRepoFullNameFromWorkspaceUrl(
          workspace.workspaceRepositoryUrl,
        )
        if (!repoFullName) continue
        try {
          await getRepoReadCloneToken(input.orgId, input.env, {
            githubConnectionId: input.connectionId,
            repoFullName,
          })
        } catch (error) {
          // GitHub refuses a token for a repository outside the installation.
          if (
            !(error instanceof RequestError) ||
            (error.status !== 404 && error.status !== 422)
          )
            logError(error)
          continue
        }
        const updated = await bindUnboundWorkspace({
          workspace,
          githubConnectionId: input.connectionId,
        })
        if (updated) await startRelinkedWorkspace(updated, input.log)
      }
    })
  } catch (error) {
    logError(error)
  }
}

async function startRelinkedWorkspace(
  workspace: WorkspaceRecord,
  log: WorkspaceLog,
): Promise<void> {
  void destroySandboxesForWorkspace(workspace.id)
  await attachOrgRepository({
    orgId: workspace.orgId,
    gitUrl: workspace.workspaceRepositoryUrl,
    githubConnectionId: workspace.githubConnectionId,
    log,
  })
  void enqueueWorkspaceTipCheck(workspace.orgId, log)
  void enqueueWorkspaceHydrate(
    { orgId: workspace.orgId, workspaceId: workspace.id },
    log,
  )
  void enqueueWorkspaceWriteCommit(
    {
      orgId: workspace.orgId,
      workspaceId: workspace.id,
      kind: "bootstrap",
    },
    log,
  )
}
