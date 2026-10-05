import { z } from "zod"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { getGithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { githubSyncIssue } from "../../../openworkflow/workflows/github-sync-issue.js"
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
  action: z.string(),
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

const issuesPayloadSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    updated_at: z.string(),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
  installation: z.object({ id: z.number() }),
})

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
  kind: "pull_request" | "issue"
  installationId: number
  githubConnectionId?: string
  sourceRepository: string
  number: number
  candidate?: GithubSyncPullRequestCandidate
  version: string | undefined
}): Promise<void> {
  const installations = await listInstallationsByGithubInstallationId(
    input.installationId,
    input.githubConnectionId,
  )
  for (const installation of installations) {
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
    const target = {
      orgId: installation.orgId,
      connectionId: installation.id,
      sourceRepository: input.sourceRepository,
      number: input.number,
    }
    try {
      if (input.kind === "issue") {
        await runWorkflowWithWorkerWake(githubSyncIssue.spec, target, {
          idempotencyKey: `github-issue:${installation.id}:${input.sourceRepository}:${input.number}:${input.version ?? "unknown"}`,
        })
        continue
      }
      await runWorkflowWithWorkerWake(
        githubSyncPullRequest.spec,
        {
          ...target,
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
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "github.pr-mirror.enqueue" },
      )
    }
  }
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
      kind: "pull_request",
      installationId: parsed.data.installation.id,
      githubConnectionId: input.githubConnectionId,
      sourceRepository: parsed.data.repository.full_name,
      number,
      candidate: candidateFromPullRequestPayload(parsed.data.pull_request),
      version: parsed.data.pull_request?.updated_at,
    })
    return
  }

  if (input.eventName === "issue_comment") {
    const parsed = issueCommentPayloadSchema.safeParse(input.payload)
    if (!parsed.success) return
    const onPullRequest = parsed.data.issue.pull_request != null
    const commentAt =
      parsed.data.comment?.updated_at ?? parsed.data.comment?.created_at
    await enqueueMirror({
      kind: onPullRequest ? "pull_request" : "issue",
      installationId: parsed.data.installation.id,
      githubConnectionId: input.githubConnectionId,
      sourceRepository: parsed.data.repository.full_name,
      number: parsed.data.issue.number,
      // A deleted comment keeps its timestamp, so issue keys carry the action.
      version: onPullRequest ? commentAt : `${parsed.data.action}:${commentAt}`,
    })
    return
  }

  if (input.eventName === "issues") {
    const parsed = issuesPayloadSchema.safeParse(input.payload)
    // Only actions that change the mirrored file. A deleted or transferred
    // issue cannot be read here; its file stays.
    const rendered = [
      "opened",
      "edited",
      "closed",
      "reopened",
      "labeled",
      "unlabeled",
      "assigned",
      "unassigned",
    ]
    if (!parsed.success || !rendered.includes(parsed.data.action)) return
    await enqueueMirror({
      kind: "issue",
      installationId: parsed.data.installation.id,
      githubConnectionId: input.githubConnectionId,
      sourceRepository: parsed.data.repository.full_name,
      number: parsed.data.issue.number,
      version: `${parsed.data.action}:${parsed.data.issue.updated_at}`,
    })
  }
}
