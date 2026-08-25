import {
  resolveWorkspaceGithubConnectionId,
  type WorkspaceAddSource,
} from "./bind-github-connection.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"
import { destroySandboxesForWorkspace } from "./sandbox-registry.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"
import {
  githubConnectionIdForWriteProbe,
  writeStatusFromClassification,
} from "./write-status.js"
import {
  createWorkspace,
  updateWorkspace,
  type WorkspaceRecord,
} from "../../models/workspaces.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { enqueueWorkspaceTipCheck } from "../../openworkflow/enqueue-workspace-tip-check.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"

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
  log: WorkspaceLog
}): Promise<void> {
  void enqueueWorkspaceWriteCommit(
    {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      kind: "ops_folder_map",
    },
    input.log,
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
    Boolean(nextUrl) && nextUrl !== input.current.workspaceRepositoryUrl
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
  if (changed) {
    void destroySandboxesForWorkspace(updated.id)
    await attachOrgRepository({
      orgId: updated.orgId,
      gitUrl: updated.workspaceRepositoryUrl,
      githubConnectionId: updated.githubConnectionId,
      log: input.log,
    })
    void enqueueWorkspaceTipCheck(updated.orgId, input.log)
    void enqueueWorkspaceHydrate(
      { orgId: updated.orgId, workspaceId: updated.id },
      input.log,
    )
    void enqueueWorkspaceWriteCommit(
      {
        orgId: updated.orgId,
        workspaceId: updated.id,
        kind: "bootstrap",
      },
      input.log,
    )
  }
  return { workspace: updated, changed }
}
