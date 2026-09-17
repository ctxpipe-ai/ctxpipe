import { z } from "zod"
import { withOrgDbContext } from "../../../db/client.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { getGithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import {
  type GithubSyncPullRequestCandidate,
  githubSyncPullRequest,
} from "../../../openworkflow/workflows/github-sync-pull-request.js"

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  number: z.number().int().positive().optional(),
  pull_request: z
    .object({
      number: z.number().int().positive(),
      merged: z.boolean().optional(),
      merged_at: z.string().nullable().optional(),
      draft: z.boolean().optional(),
      state: z.string().optional(),
      updated_at: z.string().optional(),
    })
    .optional(),
  repository: z.object({
    full_name: z.string(),
  }),
  installation: z.object({ id: z.number() }),
})

const issueCommentPayloadSchema = z.object({
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  comment: z
    .object({
      updated_at: z.string().optional(),
      created_at: z.string().optional(),
    })
    .optional(),
  repository: z.object({
    full_name: z.string(),
  }),
  installation: z.object({ id: z.number() }),
})

type GithubWebhookLog = { error: (error: Error) => void }

/** Facts the webhook payload already carries; lets the workflow apply scope policy before any API call. */
export function candidateFromPullRequestPayload(
  pull: z.infer<typeof pullRequestPayloadSchema>["pull_request"],
): GithubSyncPullRequestCandidate | undefined {
  if (!pull?.updated_at) return undefined
  const merged = pull.merged ?? (pull.merged_at != null ? true : undefined)
  if (merged === undefined || pull.draft === undefined) return undefined
  return { merged, draft: pull.draft, updatedAt: pull.updated_at }
}

export function githubPrMirrorIdempotencyKey(input: {
  connectionId: string
  sourceRepository: string
  number: number
  version: string | undefined
}): string {
  return `github-pr:${input.connectionId}:${input.sourceRepository}:${input.number}:${input.version ?? "unknown"}`
}

async function enqueueMirror(input: {
  installationId: number
  githubConnectionId?: string
  sourceRepository: string
  number: number
  candidate?: GithubSyncPullRequestCandidate
  version: string | undefined
  log: GithubWebhookLog
}): Promise<void> {
  const installations = (
    await listInstallationsByGithubInstallationId(input.installationId)
  ).filter(
    (installation) =>
      !input.githubConnectionId || installation.id === input.githubConnectionId,
  )
  for (const installation of installations) {
    const sourceRepo = await withOrgDbContext(installation.orgId, () =>
      findRepositoryByGithubInstallation(
        installation.orgId,
        input.sourceRepository,
        installation.id,
      ),
    )
    if (!sourceRepo) continue
    const binding = await getGithubPrMirrorBinding(
      installation.orgId,
      installation.id,
    )
    if (!binding?.enabled) continue
    if (
      binding.setupPhase !== "live" &&
      binding.setupPhase !== "initial_sync"
    ) {
      continue
    }
    try {
      await runWorkflowWithWorkerWake(
        githubSyncPullRequest.spec,
        {
          orgId: installation.orgId,
          connectionId: installation.id,
          sourceRepository: input.sourceRepository,
          number: input.number,
          ...(input.candidate ? { candidate: input.candidate } : {}),
        },
        {
          idempotencyKey: githubPrMirrorIdempotencyKey({
            connectionId: installation.id,
            sourceRepository: input.sourceRepository,
            number: input.number,
            version: input.version,
          }),
        },
      )
    } catch (error) {
      input.log.error(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

export async function maybeEnqueueGithubPrMirror(input: {
  eventName: string
  payload: unknown
  githubConnectionId?: string
  log: GithubWebhookLog
}): Promise<void> {
  if (
    input.eventName === "pull_request" ||
    input.eventName === "pull_request_review" ||
    input.eventName === "pull_request_review_comment"
  ) {
    const parsed = pullRequestPayloadSchema.safeParse(input.payload)
    if (!parsed.success) return
    const number = parsed.data.pull_request?.number ?? parsed.data.number
    if (number == null) return
    await enqueueMirror({
      installationId: parsed.data.installation.id,
      githubConnectionId: input.githubConnectionId,
      sourceRepository: parsed.data.repository.full_name,
      number,
      candidate: candidateFromPullRequestPayload(parsed.data.pull_request),
      version: parsed.data.pull_request?.updated_at,
      log: input.log,
    })
    return
  }

  if (input.eventName === "issue_comment") {
    const parsed = issueCommentPayloadSchema.safeParse(input.payload)
    if (!parsed.success || parsed.data.issue.pull_request == null) return
    await enqueueMirror({
      installationId: parsed.data.installation.id,
      githubConnectionId: input.githubConnectionId,
      sourceRepository: parsed.data.repository.full_name,
      number: parsed.data.issue.number,
      version:
        parsed.data.comment?.updated_at ?? parsed.data.comment?.created_at,
      log: input.log,
    })
  }
}
