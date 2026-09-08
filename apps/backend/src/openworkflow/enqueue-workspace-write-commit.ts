import { parseEnv } from "../config/env.js"
import { assertNotInOrgDbContext, withOrgDbContext } from "../db/client.js"
import { connectorMirrorContentSchema } from "../domain/workspaces/connector-mirror.js"
import { linkedRepositoryUrlSchema } from "../domain/workspaces/linked-repository-url.js"
import { resolveWorkspaceReadRevision } from "../domain/workspaces/resolve-revision.js"
import { sameWorkspaceRevision } from "../domain/workspaces/revision.js"
import type { EnqueueWriteJobInput } from "../domain/workspaces/write-job-intent.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  nextPersistedWriteProbe,
  probeWorkspaceWriteAccess,
} from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import {
  failUnscheduledWriteJob,
  persistBoundWriteJob,
  reconcileWorkspaceWriteJob,
} from "../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  persistWriteStatus,
  type WorkspaceWriteProbeBinding,
} from "../models/workspaces.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceBootstrap } from "./workflows/workspace-bootstrap.js"
import { workspaceClaimsUpgrade } from "./workflows/workspace-claims-upgrade.js"
import {
  workspaceConnectorMirror,
  workspaceConnectorMirrorInputSchema,
} from "./workflows/workspace-connector-mirror.js"
import {
  workspaceExtractIngest,
  workspaceExtractIngestInputSchema,
} from "./workflows/workspace-extract-ingest.js"
import {
  workspaceFileEdit,
  workspaceFileEditInputSchema,
} from "./workflows/workspace-file-edit.js"
import { workspaceImportKeyCleanup } from "./workflows/workspace-import-key-cleanup.js"
import {
  workspaceLinkUnlink,
  workspaceLinkUnlinkInputSchema,
} from "./workflows/workspace-link-unlink.js"
import { workspaceMigrationExport } from "./workflows/workspace-migration-export.js"
import { workspaceOpsFolderMap } from "./workflows/workspace-ops-folder-map.js"
import {
  workspaceRenameRewrite,
  workspaceRenameRewriteInputSchema,
} from "./workflows/workspace-rename-rewrite.js"
import {
  semanticMergeContentSchema,
  workspaceSemanticMerge,
  workspaceSemanticMergeInputSchema,
} from "./workflows/workspace-semantic-merge.js"
import { workspaceValidFromPersist } from "./workflows/workspace-valid-from-persist.js"

type WorkspaceWriteSnapshot = WorkspaceWriteProbeBinding & {
  writeStatus: string
}

async function probedWriteStatus(input: {
  orgId: string
  workspace: WorkspaceWriteSnapshot
}): Promise<string | null> {
  try {
    const { getGithubRepoWriteView } = await import(
      "../routes/webhooks/github/github-workspace-tip.js"
    )
    const probe = await probeWorkspaceWriteAccess({
      workspaceRepositoryUrl: input.workspace.workspaceRepositoryUrl,
      githubConnectionId: input.workspace.githubConnectionId,
      orgId: input.orgId,
      fetchWriteView: (args) =>
        getGithubRepoWriteView({
          ...args,
          env: parseEnv(process.env as Record<string, string | undefined>),
        }),
    })
    const write = nextPersistedWriteProbe({
      currentStatus: input.workspace.writeStatus,
      probe,
    })
    const persisted = await withOrgDbContext(input.orgId, () =>
      persistWriteStatus(input.workspace, write, input.orgId),
    )
    return persisted ? write.writeStatus : null
  } catch {
    return null
  }
}

export type EnqueueWorkspaceWriteCommitInput = EnqueueWriteJobInput

export async function enqueueWriteJob(
  input: EnqueueWriteJobInput,
  log: { error: (err: Error) => void },
): Promise<{ started: boolean }> {
  assertNotInOrgDbContext()
  if (input.kind === "link_unlink")
    input = {
      ...input,
      linkGitUrl: linkedRepositoryUrlSchema.parse(input.linkGitUrl),
    }
  const jobId = input.jobId ?? generateObjectId("wjob")
  let jobGeneration = input.jobGeneration
  let jobWorkspaceUrl = input.jobWorkspaceUrl
  let jobDesiredSha = input.jobDesiredSha
  let writeStatus: string | null = null
  try {
    if (input.kind === "semantic_merge") {
      const content = semanticMergeContentSchema.parse({
        previousSha: input.previousSha,
        files: input.mergeFiles ?? [],
        deletePaths: input.mergeDeletePaths ?? [],
      })
      input = {
        ...input,
        previousSha: content.previousSha,
        mergeFiles: content.files,
        mergeDeletePaths: content.deletePaths,
      }
    }
    if (input.kind === "connector_mirror")
      connectorMirrorContentSchema.parse({
        mirror: input.mirror,
        files: input.mergeFiles ?? [],
        deletePaths: input.mergeDeletePaths ?? [],
      })

    const workspace = await withOrgDbContext(input.orgId, () =>
      getWorkspaceById(input.workspaceId),
    )
    if (workspace) {
      if (
        !githubRepoFullNameFromWorkspaceUrl(workspace.workspaceRepositoryUrl) ||
        !workspace.githubConnectionId
      )
        throw new Error(
          "Workspace writes require a connected GitHub repository",
        )
      jobGeneration = jobGeneration ?? workspace.desiredGeneration
      jobWorkspaceUrl = jobWorkspaceUrl ?? workspace.workspaceRepositoryUrl
      if (jobDesiredSha === undefined) jobDesiredSha = workspace.desiredSha
      writeStatus = await probedWriteStatus({
        orgId: input.orgId,
        workspace: {
          id: workspace.id,
          desiredGeneration: workspace.desiredGeneration,
          workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
          desiredSha: workspace.desiredSha,
          desiredDefaultBranch: workspace.desiredDefaultBranch,
          writeStatus: workspace.writeStatus,
          githubConnectionId: workspace.githubConnectionId,
        },
      })
    }
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)))
    return { started: false }
  }
  if (writeStatus == null) {
    log.error(new Error("Workspace write binding is unavailable"))
    return { started: false }
  }
  // Admission selects an explicit native workflow; it does not execute a job lifecycle.
  const snapshotWriteWorkflows: Partial<
    Record<EnqueueWriteJobInput["kind"], typeof workspaceBootstrap>
  > = {
    bootstrap: workspaceBootstrap,
    migration_export: workspaceMigrationExport,
    claims_upgrade: workspaceClaimsUpgrade,
    valid_from_persist: workspaceValidFromPersist,
    import_key_cleanup: workspaceImportKeyCleanup,
    ops_folder_map: workspaceOpsFolderMap,
  }
  const snapshotWorkflow = snapshotWriteWorkflows[input.kind]
  if (
    snapshotWorkflow ||
    input.kind === "extract_ingest" ||
    input.kind === "ui_file_edit" ||
    input.kind === "link_unlink" ||
    input.kind === "rename_rewrite" ||
    input.kind === "connector_mirror" ||
    input.kind === "semantic_merge"
  ) {
    let bound = false
    try {
      const admissionStatus =
        writeStatus === "writable" ? ("queued" as const) : ("paused" as const)
      const resolved = await resolveWorkspaceReadRevision({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        env: parseEnv(process.env),
      })
      if (!resolved) throw new Error("Workspace revision is unavailable")
      const current = {
        ...resolved.revision,
        access: "write-default" as const,
      }
      const recorded = await withOrgDbContext(input.orgId, () =>
        reconcileWorkspaceWriteJob(jobId),
      )
      const captured = recorded?.payload?.revision
      if (
        captured &&
        !sameWorkspaceRevision({ ...captured, sha: current.sha }, current)
      )
        throw new Error("Captured write command belongs to a different binding")
      // A paused intent retains its original tree; the broker reconciles later tip changes.
      const revision = captured ?? current
      if (captured && input.jobDesiredSha === undefined)
        jobDesiredSha = captured.sha
      if (
        (jobGeneration != null && revision.generation !== jobGeneration) ||
        (jobWorkspaceUrl && revision.remote.url !== jobWorkspaceUrl) ||
        (jobDesiredSha && revision.sha !== jobDesiredSha) ||
        (input.defaultBranch && revision.defaultBranch !== input.defaultBranch)
      )
        throw new Error("Write command binding changed during admission")
      if (input.kind === "extract_ingest") {
        const command = workspaceExtractIngestInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          extraction: input.extraction,
        })
        await persistBoundWriteJob({
          admissionStatus,
          id: jobId,
          kind: input.kind,
          revision,
          extraction: command.extraction,
        })
        bound = true
        await runWorkflowWithWorkerWake(workspaceExtractIngest.spec, command, {
          idempotencyKey: jobId,
        })
        return { started: true }
      }
      if (input.kind === "semantic_merge") {
        const command = workspaceSemanticMergeInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          previousSha: input.previousSha,
          files: input.mergeFiles ?? [],
          deletePaths: input.mergeDeletePaths ?? [],
        })
        await persistBoundWriteJob({
          admissionStatus,
          id: jobId,
          kind: input.kind,
          revision,
          previousSha: command.previousSha,
          files: command.files,
          deletePaths: command.deletePaths,
        })
        bound = true
        await runWorkflowWithWorkerWake(workspaceSemanticMerge.spec, command, {
          idempotencyKey: jobId,
        })
        return { started: true }
      }
      if (input.kind === "connector_mirror") {
        const command = workspaceConnectorMirrorInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          mirror: input.mirror,
          files: input.mergeFiles ?? [],
          deletePaths: input.mergeDeletePaths ?? [],
        })
        await persistBoundWriteJob({
          admissionStatus,
          id: jobId,
          kind: input.kind,
          revision,
          mirror: command.mirror,
          files: command.files,
          deletePaths: command.deletePaths,
        })
        bound = true
        await runWorkflowWithWorkerWake(
          workspaceConnectorMirror.spec,
          command,
          { idempotencyKey: jobId },
        )
        return { started: true }
      }
      if (input.kind === "rename_rewrite") {
        const command = workspaceRenameRewriteInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          previousSha: input.previousSha,
        })
        await persistBoundWriteJob({
          admissionStatus,
          id: jobId,
          kind: input.kind,
          revision,
          previousSha: command.previousSha,
        })
        bound = true
        await runWorkflowWithWorkerWake(workspaceRenameRewrite.spec, command, {
          idempotencyKey: jobId,
        })
        return { started: true }
      }
      if (input.kind === "link_unlink") {
        const command = workspaceLinkUnlinkInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          linkAction: input.linkAction,
          linkGitUrl: input.linkGitUrl,
        })
        await persistBoundWriteJob({
          admissionStatus,
          id: jobId,
          kind: input.kind,
          revision,
          linkAction: command.linkAction,
          linkGitUrl: command.linkGitUrl,
        })
        bound = true
        await runWorkflowWithWorkerWake(workspaceLinkUnlink.spec, command, {
          idempotencyKey: jobId,
        })
        return { started: true }
      }
      if (input.kind === "ui_file_edit") {
        const command = workspaceFileEditInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          files: input.mergeFiles ?? [],
          deletePaths: input.mergeDeletePaths ?? [],
        })
        await persistBoundWriteJob({
          admissionStatus,
          id: jobId,
          kind: input.kind,
          revision,
          files: command.files,
          deletePaths: command.deletePaths,
        })
        bound = true
        await runWorkflowWithWorkerWake(workspaceFileEdit.spec, command, {
          idempotencyKey: jobId,
        })
        return { started: true }
      }
      if (!snapshotWorkflow)
        throw new Error("No typed workflow for this write kind")
      const command = {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        jobId,
        revision,
        ...(input.kind === "ops_folder_map" && input.displayName !== undefined
          ? { displayName: input.displayName.trim() }
          : {}),
      }
      await persistBoundWriteJob({
        admissionStatus,
        id: jobId,
        kind: input.kind,
        revision,
        displayName: command.displayName,
      })
      bound = true
      await runWorkflowWithWorkerWake(snapshotWorkflow.spec, command, {
        idempotencyKey: jobId,
      })
      return { started: true }
    } catch (error) {
      if (bound) {
        try {
          await failUnscheduledWriteJob(jobId)
        } catch (statusError) {
          log.error(
            statusError instanceof Error
              ? statusError
              : new Error(String(statusError)),
          )
        }
      }
      log.error(error instanceof Error ? error : new Error(String(error)))
      return { started: false }
    }
  }
  log.error(new Error("No typed workflow for this write kind"))
  return { started: false }
}

export const enqueueWorkspaceWriteCommit = enqueueWriteJob
