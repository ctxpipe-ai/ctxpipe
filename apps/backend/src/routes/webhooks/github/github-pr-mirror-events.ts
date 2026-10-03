import { z } from "zod"
import { normalizeWorkspaceRepositoryUrl } from "../../../domain/workspaces/slug.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { listGithubPrMirrorWorkspaceIds } from "../../../models/github-pr-mirror.js"
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
    pull_request: z
      .object({ merged_at: z.string().nullable().optional() })
      .optional(),
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

/** Facts the webhook payload already carries; lets the workflow apply the policy before any API call. */
export function candidateFromPullRequestPayload(
  pull: z.infer<typeof pullRequestPayloadSchema>["pull_request"],
): GithubSyncPullRequestCandidate | undefined {
  if (!pull?.updated_at) return undefined
  const merged = pull.merged ?? (pull.merged_at != null ? true : undefined)
  if (merged === undefined || pull.draft === undefined) return undefined
  return { merged, draft: pull.draft, updatedAt: pull.updated_at }
}

/** A replayed delivery maps to the same run per Workspace. */
export function githubPrMirrorIdempotencyKey(input: {
  workspaceId: string
  gitUrl: string
  number: number
  version: string | undefined
}): string {
  return `github-pr:${input.workspaceId}:${input.gitUrl}:${input.number}:${input.version ?? "unknown"}`
}

/**
 * One mirror job per Workspace that links the repository; none when no
 * Workspace does. A failed enqueue throws so the delivery answers 5xx and
 * GitHub's redelivery retries; the idempotency key skips jobs already started.
 */
async function enqueueMirror(input: {
  installationId: number
  githubConnectionId?: string
  repositoryFullName: string
  number: number
  candidate?: GithubSyncPullRequestCandidate
  version: string | undefined
}): Promise<void> {
  const gitUrl = normalizeWorkspaceRepositoryUrl(
    `https://github.com/${input.repositoryFullName}`,
  )
  const installations = (
    await listInstallationsByGithubInstallationId(input.installationId)
  ).filter(
    (installation) =>
      !input.githubConnectionId || installation.id === input.githubConnectionId,
  )
  const failures: unknown[] = []
  for (const installation of installations) {
    const workspaceIds = await listGithubPrMirrorWorkspaceIds({
      orgId: installation.orgId,
      gitUrl,
    })
    for (const workspaceId of workspaceIds) {
      await runWorkflowWithWorkerWake(
        githubSyncPullRequest.spec,
        {
          orgId: installation.orgId,
          workspaceId,
          gitUrl,
          connectionId: installation.id,
          numbers: [input.number],
          ...(input.candidate ? { candidate: input.candidate } : {}),
        },
        {
          idempotencyKey: githubPrMirrorIdempotencyKey({
            workspaceId,
            gitUrl,
            number: input.number,
            version: input.version,
          }),
        },
      ).catch((error: unknown) => failures.push(error))
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "GitHub pull request mirror could not be enqueued",
    )
}

export async function maybeEnqueueGithubPrMirror(input: {
  eventName: string
  payload: unknown
  githubConnectionId?: string
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
      repositoryFullName: parsed.data.repository.full_name,
      number,
      candidate: candidateFromPullRequestPayload(parsed.data.pull_request),
      version: parsed.data.pull_request?.updated_at,
    })
    return
  }

  if (input.eventName === "issue_comment") {
    const parsed = issueCommentPayloadSchema.safeParse(input.payload)
    // Only comments on merged pull requests reach the mirror.
    const mergedAt = parsed.data?.issue.pull_request?.merged_at
    if (!parsed.success || !mergedAt) return
    const version =
      parsed.data.comment?.updated_at ?? parsed.data.comment?.created_at
    await enqueueMirror({
      installationId: parsed.data.installation.id,
      githubConnectionId: input.githubConnectionId,
      repositoryFullName: parsed.data.repository.full_name,
      number: parsed.data.issue.number,
      candidate: {
        merged: true,
        draft: false,
        updatedAt: version ?? mergedAt,
      },
      version,
    })
  }
}
