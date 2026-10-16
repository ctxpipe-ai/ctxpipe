import { z } from "zod"
import type { GitFileChange } from "../../services/git/file-change.js"
import { gitFileChangeSchema } from "../../services/git/file-change.js"
import type { UnbornBootstrapBinding } from "./bootstrap-input.js"
import type { ConnectorMirrorSource } from "./connector-mirror-input.js"
import { connectorMirrorSourceSchema } from "./connector-mirror-input.js"
import {
  type WorkspaceExtraction,
  workspaceExtractionSchema,
} from "./extraction.js"
import type { IngestPublishSource } from "./extraction-source.js"
import type { WorkspaceRevision } from "./revision.js"
import type { WorkspaceWriteJobKind } from "./write-jobs.js"
import { shouldEnqueueWorkspaceWriteJob } from "./write-jobs.js"

export const WRITE_JOB_STATUSES = {
  queued: "queued",
  running: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
} as const

export type WriteJobStatus =
  (typeof WRITE_JOB_STATUSES)[keyof typeof WRITE_JOB_STATUSES]

export type WorkspaceSemanticHandoff = {
  ownerRunId: string
  candidateSha: string
  revision: WorkspaceRevision
  files: GitFileChange[]
  deletePaths: string[]
}

export type WorkspaceWritePlanning = {
  rootSha: string
  attempt: number
  remainder: number
}

export type WorkspaceWriteJobPayload = {
  bootstrapBinding?: UnbornBootstrapBinding
  extraction?: WorkspaceExtraction
  /** An ingestion v2 publish (T21): the run and its assembled tip. */
  ingest?: IngestPublishSource
  revision?: WorkspaceRevision
  planning?: WorkspaceWritePlanning
  workflowRunId?: string
  semanticHandoff?: WorkspaceSemanticHandoff
  knowledgePaths?: Record<string, string>
  previousSha?: string
  mirror?: ConnectorMirrorSource
  displayName?: string
  /** The source repository that an `unlink_retraction` job retracts. */
  retractRepositoryUrl?: string
  /** The removed source file of that repository (ADR-050, 2026-10-16). */
  retractSourcePath?: string
  /** Why the job failed, when it failed for a known reason. */
  failureReason?: string
  defaultBranch?: string
  jobWorkspaceUrl?: string
  conflictParentSha?: string | null
  remoteTipSha?: string | null
  mergeFiles?: GitFileChange[]
  mergeDeletePaths?: string[]
}

const writeJobBaseSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  jobGeneration: z.number().int().optional(),
  jobWorkspaceUrl: z.string().min(1).optional(),
  jobDesiredSha: z.string().nullable().optional(),
  defaultBranch: z.string().min(1).optional(),
})

const writeJobKindSchema = z.enum([
  "extract_ingest",
  "connector_mirror",
  "claims_upgrade",
  "rename_rewrite",
  "valid_from_persist",
  "semantic_merge",
  "ops_folder_map",
  "bootstrap",
  "ui_file_edit",
  "import_key_cleanup",
  "ownership_migration",
  "unlink_retraction",
])

/** Shared enqueue + workflow input. Kind-specific fields stay on the payload. */
export const workspaceWriteJobInputSchema = writeJobBaseSchema.extend({
  kind: writeJobKindSchema,
  extraction: workspaceExtractionSchema.optional(),
  mirror: connectorMirrorSourceSchema.optional(),
  previousSha: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .optional(),
  displayName: z.string().trim().min(1).optional(),
  retractRepositoryUrl: z.string().min(1).optional(),
  retractSourcePath: z.string().min(1).optional(),
  conflictParentSha: z.string().nullable().optional(),
  remoteTipSha: z.string().nullable().optional(),
  mergeFiles: z.array(gitFileChangeSchema).optional(),
  mergeDeletePaths: z.array(z.string().min(1)).optional(),
})

export type EnqueueWriteJobInput = z.infer<typeof workspaceWriteJobInputSchema>

export type WriteJobEnqueueFields = Pick<
  EnqueueWriteJobInput,
  | "extraction"
  | "kind"
  | "previousSha"
  | "mirror"
  | "displayName"
  | "defaultBranch"
  | "retractRepositoryUrl"
  | "retractSourcePath"
  | "jobWorkspaceUrl"
  | "conflictParentSha"
  | "remoteTipSha"
  | "mergeFiles"
  | "mergeDeletePaths"
>

export function writeJobIntentPayload(
  input: WriteJobEnqueueFields,
): WorkspaceWriteJobPayload {
  const payload: WorkspaceWriteJobPayload = {}
  if (input.extraction) payload.extraction = input.extraction
  if (input.mirror) payload.mirror = input.mirror
  if (input.previousSha) payload.previousSha = input.previousSha
  if (input.displayName !== undefined) payload.displayName = input.displayName
  if (input.retractRepositoryUrl)
    payload.retractRepositoryUrl = input.retractRepositoryUrl
  if (input.retractSourcePath)
    payload.retractSourcePath = input.retractSourcePath
  if (input.defaultBranch) payload.defaultBranch = input.defaultBranch
  if (input.jobWorkspaceUrl) payload.jobWorkspaceUrl = input.jobWorkspaceUrl
  if (input.conflictParentSha !== undefined) {
    payload.conflictParentSha = input.conflictParentSha
  }
  if (input.remoteTipSha !== undefined) {
    payload.remoteTipSha = input.remoteTipSha
  }
  if (input.mergeFiles) payload.mergeFiles = input.mergeFiles
  if (input.mergeDeletePaths) payload.mergeDeletePaths = input.mergeDeletePaths
  return payload
}

export function writeJobIntentStatus(input: {
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
}): WriteJobStatus | "stale_generation" {
  const gate = shouldEnqueueWorkspaceWriteJob(input)
  if (!gate.enqueue) return gate.reason
  return WRITE_JOB_STATUSES.queued
}

export function countsTowardWriteJobAttempts(status: string): boolean {
  return (
    status !== WRITE_JOB_STATUSES.paused && status !== WRITE_JOB_STATUSES.queued
  )
}

export function shouldResumePausedWriteJob(input: {
  status: string
  generation: number
  desiredGeneration: number
  writeStatus: string
  jobWorkspaceUrl: string
  desiredWorkspaceUrl: string
}): boolean {
  if (input.status !== WRITE_JOB_STATUSES.paused) return false
  if (input.jobWorkspaceUrl !== input.desiredWorkspaceUrl) return false
  return (
    shouldEnqueueWorkspaceWriteJob({
      writeStatus: input.writeStatus,
      jobGeneration: input.generation,
      desiredGeneration: input.desiredGeneration,
    }).enqueue === true
  )
}

export function enqueueInputFromPausedJob(input: {
  orgId: string
  workspaceId: string
  job: {
    id: string
    kind: WorkspaceWriteJobKind
    generation: number
    desiredSha: string | null
    payload: WorkspaceWriteJobPayload | null
  }
}): EnqueueWriteJobInput {
  const payload = input.job.payload ?? {}
  return {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    kind: input.job.kind,
    jobId: input.job.id,
    jobGeneration: input.job.generation,
    jobDesiredSha: input.job.desiredSha,
    ...(payload.jobWorkspaceUrl
      ? { jobWorkspaceUrl: payload.jobWorkspaceUrl }
      : {}),
    ...(payload.defaultBranch ? { defaultBranch: payload.defaultBranch } : {}),
    ...(payload.displayName !== undefined
      ? { displayName: payload.displayName }
      : {}),
    ...(payload.extraction ? { extraction: payload.extraction } : {}),
    ...(payload.mirror ? { mirror: payload.mirror } : {}),
    ...(payload.previousSha ? { previousSha: payload.previousSha } : {}),
    ...(payload.retractRepositoryUrl
      ? { retractRepositoryUrl: payload.retractRepositoryUrl }
      : {}),
    ...(payload.retractSourcePath
      ? { retractSourcePath: payload.retractSourcePath }
      : {}),
    ...(payload.conflictParentSha !== undefined
      ? { conflictParentSha: payload.conflictParentSha }
      : {}),
    ...(payload.remoteTipSha !== undefined
      ? { remoteTipSha: payload.remoteTipSha }
      : {}),
    ...(payload.mergeFiles ? { mergeFiles: payload.mergeFiles } : {}),
    ...(payload.mergeDeletePaths
      ? { mergeDeletePaths: payload.mergeDeletePaths }
      : {}),
  }
}
