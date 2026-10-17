import { parseEnv } from "../config/env.js"
import { assertNotInOrgDbContext, withOrgDbContext } from "../db/client.js"
import { workspacePublishPipeline } from "../domain/ingestion/ingestion-v2-config.js"
import { captureUnbornBootstrapBinding } from "../domain/workspaces/bootstrap-unborn.js"
import { connectorMirrorContentSchema } from "../domain/workspaces/connector-mirror-input.js"
import {
  resolveRepositoryReadCredential,
  resolveWorkspaceReadRevision,
} from "../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "../domain/workspaces/revision.js"
import { workspaceRootPath } from "../domain/workspaces/root-path.js"
import {
  INGESTION_V2_PUBLISH_FORMAT,
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
  withFormatWriteGate,
  workspaceFormatAtLeast,
  workspaceFormatCacheValue,
} from "../domain/workspaces/workspace-format.js"
import type { EnqueueWriteJobInput } from "../domain/workspaces/write-job-intent.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  nextPersistedWriteProbe,
  probeWorkspaceWriteAccess,
} from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import {
  persistBoundWriteJob,
  persistUnbornBootstrapJob,
  persistWriteJobStatus,
  reconcileWorkspaceWriteJob,
  reconcileWriteJobAdmission,
} from "../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  persistWriteStatus,
  type WorkspaceWriteProbeBinding,
} from "../models/workspaces.js"
import { listMarkdownFilesAtGitSha } from "../services/git/clone-tree.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"
import { workspaceBootstrap } from "./workflows/workspace-bootstrap.js"
import { workspaceClaimsUpgrade } from "./workflows/workspace-claims-upgrade.js"
import {
  workspaceConnectorMirror,
  workspaceConnectorMirrorInputSchema,
} from "./workflows/workspace-connector-mirror.js"
import {
  workspaceFileEdit,
  workspaceFileEditInputSchema,
} from "./workflows/workspace-file-edit.js"
import { workspaceImportKeyCleanup } from "./workflows/workspace-import-key-cleanup.js"
import { workspaceOpsFolderList } from "./workflows/workspace-ops-folder-list.js"
import { workspaceOwnershipMigration } from "./workflows/workspace-ownership-migration.js"
import {
  workspaceRenameRewrite,
  workspaceRenameRewriteInputSchema,
} from "./workflows/workspace-rename-rewrite.js"
import {
  semanticMergeContentSchema,
  workspaceSemanticMerge,
  workspaceSemanticMergeInputSchema,
} from "./workflows/workspace-semantic-merge.js"
import {
  workspaceUnlinkRetraction,
  workspaceUnlinkRetractionInputSchema,
} from "./workflows/workspace-unlink-retraction.js"
import { workspaceValidFromPersist } from "./workflows/workspace-valid-from-persist.js"

type WorkspaceWriteSnapshot = WorkspaceWriteProbeBinding & {
  writeStatus: string
  formatVersion: number | null
}

/**
 * Probes GitHub write access and stores the result. Returns the stored status
 * and the tip of the row that holds it.
 *
 * A relink starts a tip check and a hydrate beside its bootstrap. They can
 * store a new tip or default branch during the probe. The probe reads only the
 * repository and the connection. Thus, with `retry`, the result is stored
 * again on the new row while the generation, the URL and the connection stay
 * the same.
 */
async function storeProbedWriteStatus(input: {
  orgId: string
  workspace: WorkspaceWriteSnapshot
  retry: boolean
}): Promise<{ writeStatus: string; desiredSha: string | null } | null> {
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
    let workspace: WorkspaceWriteSnapshot = input.workspace
    for (let attempt = 0; attempt < 3; attempt++) {
      const write = nextPersistedWriteProbe({
        currentStatus: workspace.writeStatus,
        probe,
      })
      const stored = await withOrgDbContext(input.orgId, () =>
        persistWriteStatus(workspace, write, input.orgId),
      )
      // The format gate is on top of the stored probe result.
      if (stored)
        return {
          writeStatus: withFormatWriteGate({
            ...write,
            formatVersion: workspace.formatVersion,
          }).writeStatus,
          desiredSha: workspace.desiredSha,
        }
      if (!input.retry) return null
      const latest = await withOrgDbContext(input.orgId, () =>
        getWorkspaceById(input.workspace.id),
      )
      if (
        !latest ||
        latest.desiredGeneration !== input.workspace.desiredGeneration ||
        latest.workspaceRepositoryUrl !==
          input.workspace.workspaceRepositoryUrl ||
        latest.githubConnectionId !== input.workspace.githubConnectionId
      )
        return null
      workspace = latest
    }
    return null
  } catch {
    return null
  }
}

export type EnqueueWorkspaceWriteCommitInput = EnqueueWriteJobInput

/** The format in the tree of `revision` (0 with no format file). */
async function tipWorkspaceFormat(
  orgId: string,
  revision: WorkspaceRevision,
): Promise<number> {
  const [file] = await listMarkdownFilesAtGitSha({
    url: revision.remote.url,
    sha: revision.sha,
    token: await resolveRepositoryReadCredential({
      orgId,
      env: parseEnv(process.env),
      remote: revision.remote,
    }),
    root: workspaceRootPath(revision),
    // Fetch only the blobs of `.ctxpipe/`.
    prefix: ".ctxpipe/",
    extraPaths: [WORKSPACE_FORMAT_PATH],
  }).then((files) => files.filter((f) => f.path === WORKSPACE_FORMAT_PATH))
  return workspaceFormatCacheValue(readWorkspaceFormat(file?.content ?? null))
}

export async function enqueueWriteJob(
  input: EnqueueWriteJobInput,
  log: { error: (err: Error) => void },
): Promise<{ started: boolean }> {
  assertNotInOrgDbContext()
  const jobId = input.jobId ?? generateObjectId("wjob")
  let jobGeneration = input.jobGeneration
  let jobWorkspaceUrl = input.jobWorkspaceUrl
  let jobDesiredSha = input.jobDesiredSha
  let writeStatus: string | null = null
  let formatVersion: number | null = null
  // A new bootstrap binds the current tip, so a moved tip does not refuse it.
  const rebindsTip =
    input.kind === "bootstrap" && input.jobDesiredSha === undefined
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
      const stored = await storeProbedWriteStatus({
        orgId: input.orgId,
        workspace,
        retry: rebindsTip,
      })
      writeStatus = stored?.writeStatus ?? null
      formatVersion = workspace.formatVersion
      if (jobDesiredSha === undefined)
        jobDesiredSha = stored ? stored.desiredSha : workspace.desiredSha
    }
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)))
    return { started: false }
  }
  if (writeStatus == null) {
    log.error(new Error("Workspace write binding is unavailable"))
    return { started: false }
  }
  // The old pipeline is gone. Ingestion v2 publishes through its
  // own run, not through admission, so admission refuses each extract ingest.
  // A paused job of the old pipeline ends here, so no resume admits it again.
  if (input.kind === "extract_ingest") {
    const reason =
      "The old ingestion pipeline is retired. Admission refuses its extract_ingest write; ingestion v2 publishes to a Workspace at format 3 or more."
    log.error(new Error(reason))
    if (input.jobId)
      await withOrgDbContext(input.orgId, () =>
        persistWriteJobStatus(jobId, "completed", reason),
      )
    return { started: false }
  }
  // The Workspace format selects the ingestion (ADR-052 phase 4, G5). An
  // unlink retraction and an ownership migration are ingestion v2. Admission
  // reads the cached format; the job reads it again from the tree that it
  // pushes on.
  const pipeline = workspacePublishPipeline(formatVersion)
  if (
    (input.kind === "unlink_retraction" ||
      input.kind === "ownership_migration") &&
    pipeline !== "v2"
  ) {
    log.error(
      new Error(
        `The Workspace format selects no ingestion (${pipeline}). It refuses the ${input.kind} write.`,
      ),
    )
    return { started: false }
  }
  // Admission selects an explicit native workflow; it does not execute a job lifecycle.
  const snapshotWriteWorkflows: Partial<
    Record<
      EnqueueWriteJobInput["kind"],
      typeof workspaceClaimsUpgrade | typeof workspaceOwnershipMigration
    >
  > = {
    claims_upgrade: workspaceClaimsUpgrade,
    valid_from_persist: workspaceValidFromPersist,
    import_key_cleanup: workspaceImportKeyCleanup,
    ownership_migration: workspaceOwnershipMigration,
    ops_folder_map: workspaceOpsFolderList,
  }
  const snapshotWorkflow = snapshotWriteWorkflows[input.kind]
  if (
    input.kind === "bootstrap" ||
    snapshotWorkflow ||
    input.kind === "ui_file_edit" ||
    input.kind === "rename_rewrite" ||
    input.kind === "connector_mirror" ||
    input.kind === "semantic_merge" ||
    input.kind === "unlink_retraction"
  ) {
    let bound = false
    try {
      let admissionStatus: "queued" | "paused" =
        writeStatus === "writable" ? "queued" : "paused"
      const recorded = await withOrgDbContext(input.orgId, () =>
        reconcileWorkspaceWriteJob(jobId),
      )
      if (input.kind === "bootstrap") {
        const bootstrapBinding =
          recorded?.payload?.bootstrapBinding ??
          (await captureUnbornBootstrapBinding({
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            env: parseEnv(process.env),
          }))
        if (bootstrapBinding) {
          if (
            (jobGeneration != null &&
              bootstrapBinding.generation !== jobGeneration) ||
            (jobWorkspaceUrl &&
              bootstrapBinding.remote.url !== jobWorkspaceUrl) ||
            (input.defaultBranch &&
              bootstrapBinding.defaultBranch !== input.defaultBranch) ||
            input.jobDesiredSha != null
          )
            throw new Error(
              "Bootstrap command binding changed during admission",
            )
          await persistUnbornBootstrapJob({
            id: jobId,
            binding: bootstrapBinding,
            admissionStatus,
          })
          bound = true
          await runWorkflowWithWorkerWake(
            workspaceBootstrap.spec,
            {
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              jobId,
              bootstrapBinding,
            },
            { idempotencyKey: jobId },
          )
          return { started: true }
        }
      }
      const captured = recorded?.payload?.revision
      if (captured && input.jobDesiredSha === undefined)
        jobDesiredSha = captured.sha
      let revision: NonNullable<typeof captured>
      for (let attempt = 0; ; attempt++) {
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
        if (
          captured &&
          !sameWorkspaceRevision({ ...captured, sha: current.sha }, current)
        )
          throw new Error(
            "Captured write command belongs to a different binding",
          )
        // A pre-upgrade paused intent stored its SHA beside the payload. Bind that
        // same tree once; the broker owns reconciliation with later remote tips.
        const legacySha =
          !captured &&
          recorded &&
          ["paused", "queued"].includes(recorded.status) &&
          !recorded.commitSha &&
          !recorded.payload?.workflowRunId
            ? recorded.desiredSha
            : null
        revision = captured ?? { ...current, sha: legacySha ?? current.sha }
        const sameBinding =
          (jobGeneration == null || revision.generation === jobGeneration) &&
          (!jobWorkspaceUrl || revision.remote.url === jobWorkspaceUrl) &&
          (!input.defaultBranch ||
            revision.defaultBranch === input.defaultBranch)
        if (sameBinding && (!jobDesiredSha || revision.sha === jobDesiredSha))
          break
        // The tip can move after the write status is stored. A new bootstrap
        // then probes again, stores the status on the new row and resolves
        // again.
        if (!sameBinding || !rebindsTip || captured || attempt >= 2)
          throw new Error("Write command binding changed during admission")
        const stored = await storeProbedWriteStatus({
          orgId: input.orgId,
          workspace: resolved.workspace,
          retry: true,
        })
        if (!stored) throw new Error("Workspace write binding is unavailable")
        jobDesiredSha = stored.desiredSha
        admissionStatus =
          stored.writeStatus === "writable" ? "queued" : "paused"
      }
      // A bind or rebind writes the bootstrap files directly only at format
      // 3 or more. Below 3 the upgrade pull request carries them (ADR-053
      // section 7), so the scan offers the upgrade instead. An empty
      // repository took the root commit path above.
      if (
        rebindsTip &&
        !workspaceFormatAtLeast(
          await tipWorkspaceFormat(input.orgId, revision),
          INGESTION_V2_PUBLISH_FORMAT,
        )
      ) {
        const { enqueueWorkspaceUpgradeScan } = await import(
          "./workflows/workspace-upgrade-scan.js"
        )
        await enqueueWorkspaceUpgradeScan({
          orgId: input.orgId,
          trigger: `bind:${input.workspaceId}:${revision.sha}`,
        })
        return { started: false }
      }
      if (input.kind === "semantic_merge") {
        const command = workspaceSemanticMergeInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          // A direct semantic merge carries no trusted origin, so it gets
          // every check (CTX-722).
          origin: "agent",
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
      if (input.kind === "unlink_retraction") {
        const command = workspaceUnlinkRetractionInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          retractRepositoryUrl: input.retractRepositoryUrl,
          retractSourcePath: input.retractSourcePath,
        })
        await persistBoundWriteJob({
          admissionStatus,
          id: jobId,
          kind: input.kind,
          revision,
          retractRepositoryUrl: command.retractRepositoryUrl,
          retractSourcePath: command.retractSourcePath,
        })
        bound = true
        await runWorkflowWithWorkerWake(
          workspaceUnlinkRetraction.spec,
          command,
          { idempotencyKey: jobId },
        )
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
      if (!snapshotWorkflow && input.kind !== "bootstrap")
        throw new Error("No typed workflow for this write kind")
      const command = {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        jobId,
        revision,
        ...(input.kind === "ops_folder_map" && input.displayName !== undefined
          ? { displayName: input.displayName.trim() }
          : {}),
        ...(input.kind === "ops_folder_map" && input.previousSha
          ? { previousSha: input.previousSha }
          : {}),
      }
      await persistBoundWriteJob({
        admissionStatus,
        id: jobId,
        kind: input.kind,
        revision,
        displayName: command.displayName,
        previousSha: command.previousSha,
      })
      bound = true
      if (input.kind === "bootstrap")
        await runWorkflowWithWorkerWake(workspaceBootstrap.spec, command, {
          idempotencyKey: jobId,
        })
      else if (snapshotWorkflow)
        await runWorkflowWithWorkerWake(snapshotWorkflow.spec, command, {
          idempotencyKey: jobId,
        })
      return { started: true }
    } catch (error) {
      if (bound) {
        try {
          if (await reconcileWriteJobAdmission(jobId)) {
            scheduleEnsureWorkerRunning()
            return { started: true }
          }
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
