import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { generateObjectId } from "../../lib/id.js"
import { resolveRepoReadCoverage } from "../../models/github-installation.js"
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
import { workspaceRootPath } from "./root-path.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"
import { destroySandboxesForWorkspace } from "./workspace-sandbox-cleanup.js"
import {
  githubConnectionIdForWriteProbe,
  githubRepoFullNameFromWorkspaceUrl,
  writeStatusFromClassification,
} from "./write-status.js"

type WorkspaceLog = { error: (err: Error) => void }

async function attachOrgRepository(input: {
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
  rootPath?: string
  env: Env
  log: WorkspaceLog
}): Promise<WorkspaceRecord> {
  const githubConnectionId = await resolveWorkspaceGithubConnectionId({
    orgId: input.orgId,
    requested: input.githubConnectionId,
    source: input.source,
    gitUrl: input.gitUrl,
    env: input.env,
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
    ...(input.rootPath !== undefined ? { rootPath: input.rootPath } : {}),
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
    { orgId: created.orgId, workspaceId: created.id, kind: "bootstrap" },
    input.log,
  )
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
  rootPath?: string
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
    (input.rootPath !== undefined &&
      workspaceRootPath(input) !== workspaceRootPath(input.current)) ||
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
    ...(input.rootPath !== undefined ? { rootPath: input.rootPath } : {}),
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
  /** Check only these `owner/name` repositories (an access change names them). */
  repoFullNames?: string[]
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
        if (
          input.repoFullNames &&
          !input.repoFullNames.some(
            (name) => name.toLowerCase() === repoFullName.toLowerCase(),
          )
        )
          continue
        // `unknown` (a GitHub error) leaves the workspace unbound.
        const coverage = await resolveRepoReadCoverage(input.orgId, input.env, {
          githubConnectionId: input.connectionId,
          repoFullName,
        })
        if (coverage !== "covers") continue
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
