import { z } from "zod"
import type { WorkspaceWriteKind } from "./write-commit-files.js"
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

export type WorkspaceWriteJobPayload = {
  linkAction?: "link" | "unlink"
  linkGitUrl?: string
  defaultBranch?: string
  jobWorkspaceUrl?: string
  conflictParentSha?: string | null
  remoteTipSha?: string | null
  mergeFiles?: Array<{ path: string; content: string }>
  mergeDeletePaths?: string[]
}

const writeJobFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

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
  "migration_export",
  "extract_ingest",
  "connector_mirror",
  "claims_upgrade",
  "rename_rewrite",
  "valid_from_persist",
  "semantic_merge",
  "ops_folder_map",
  "bootstrap",
  "link_unlink",
  "ui_file_edit",
])

/** Shared enqueue + workflow input. Kind-specific fields stay on the payload. */
export const workspaceWriteJobInputSchema = writeJobBaseSchema.extend({
  kind: writeJobKindSchema,
  linkAction: z.enum(["link", "unlink"]).optional(),
  linkGitUrl: z.string().min(1).optional(),
  conflictParentSha: z.string().nullable().optional(),
  remoteTipSha: z.string().nullable().optional(),
  mergeFiles: z.array(writeJobFileSchema).optional(),
  mergeDeletePaths: z.array(z.string().min(1)).optional(),
})

export type EnqueueWriteJobInput = z.infer<typeof workspaceWriteJobInputSchema>

export type WriteJobEnqueueFields = Pick<
  EnqueueWriteJobInput,
  | "kind"
  | "defaultBranch"
  | "linkAction"
  | "linkGitUrl"
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
  if (input.linkAction) payload.linkAction = input.linkAction
  if (input.linkGitUrl) payload.linkGitUrl = input.linkGitUrl
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
    kind: WorkspaceWriteKind
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
    ...(payload.linkAction ? { linkAction: payload.linkAction } : {}),
    ...(payload.linkGitUrl ? { linkGitUrl: payload.linkGitUrl } : {}),
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
