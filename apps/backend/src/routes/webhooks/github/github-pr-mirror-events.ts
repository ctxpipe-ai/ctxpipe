import { z } from "zod"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { getGithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import { getLogger } from "../../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { githubSyncContent } from "../../../openworkflow/workflows/github-sync-content.js"
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
      id: z.number().optional(),
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
  label: z.object({ name: z.string() }).optional(),
  assignee: z.object({ login: z.string() }).nullish(),
  repository: z.object({
    full_name: z.string(),
  }),
  installation: z.object({ id: z.number() }),
})

const installationPayloadSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    updated_at: z.string().optional(),
  }),
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

/**
 * Runs `enqueue` for each GitHub connection of this installation whose mirror
 * is live, then fails the delivery (5xx) if any enqueue failed, so GitHub
 * records it and it can be redelivered.
 */
async function enqueueMirror(
  input: { installationId: number; githubConnectionId?: string },
  enqueue: (connection: {
    orgId: string
    connectionId: string
  }) => Promise<unknown>,
): Promise<void> {
  const installations = await listInstallationsByGithubInstallationId(
    input.installationId,
    input.githubConnectionId,
  )
  let failure: unknown
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
    try {
      await enqueue({
        orgId: installation.orgId,
        connectionId: installation.id,
      })
    } catch (error) {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "github.pr-mirror.enqueue" },
      )
      failure ??= error
    }
  }
  if (failure) throw failure
}

function enqueueIssueSync(input: {
  installationId: number
  githubConnectionId?: string
  sourceRepository: string
  number: number
  version: string
}): Promise<void> {
  return enqueueMirror(input, (connection) =>
    runWorkflowWithWorkerWake(
      githubSyncIssue.spec,
      {
        ...connection,
        sourceRepository: input.sourceRepository,
        number: input.number,
      },
      {
        idempotencyKey: `github-issue:${connection.connectionId}:${input.sourceRepository}:${input.number}:${input.version}`,
      },
    ),
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
    const sourceRepository = parsed.data.repository.full_name
    const candidate = candidateFromPullRequestPayload(parsed.data.pull_request)
    await enqueueMirror(
      {
        installationId: parsed.data.installation.id,
        githubConnectionId: input.githubConnectionId,
      },
      (connection) =>
        runWorkflowWithWorkerWake(
          githubSyncPullRequest.spec,
          {
            ...connection,
            sourceRepository,
            number,
            ...(candidate ? { candidate } : {}),
          },
          {
            idempotencyKey: githubPrMirrorIdempotencyKey({
              connectionId: connection.connectionId,
              sourceRepository,
              number,
              version: parsed.data.pull_request?.updated_at,
            }),
          },
        ),
    )
    return
  }

  if (input.eventName === "issue_comment") {
    const parsed = issueCommentPayloadSchema.safeParse(input.payload)
    if (!parsed.success) return
    const sourceRepository = parsed.data.repository.full_name
    const number = parsed.data.issue.number
    const commentAt =
      parsed.data.comment?.updated_at ?? parsed.data.comment?.created_at
    if (parsed.data.issue.pull_request == null) {
      // A deleted comment keeps its timestamp, and two comments can share a
      // second, so issue keys carry the action and the comment id.
      await enqueueIssueSync({
        installationId: parsed.data.installation.id,
        githubConnectionId: input.githubConnectionId,
        sourceRepository,
        number,
        version: [parsed.data.action, parsed.data.comment?.id, commentAt].join(
          ":",
        ),
      })
      return
    }
    await enqueueMirror(
      {
        installationId: parsed.data.installation.id,
        githubConnectionId: input.githubConnectionId,
      },
      (connection) =>
        runWorkflowWithWorkerWake(
          githubSyncPullRequest.spec,
          { ...connection, sourceRepository, number },
          {
            idempotencyKey: githubPrMirrorIdempotencyKey({
              connectionId: connection.connectionId,
              sourceRepository,
              number,
              version: commentAt,
            }),
          },
        ),
    )
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
    const { action, issue, label, assignee } = parsed.data
    await enqueueIssueSync({
      installationId: parsed.data.installation.id,
      githubConnectionId: input.githubConnectionId,
      sourceRepository: parsed.data.repository.full_name,
      number: issue.number,
      // Two label or assignee changes can share a second; name the one changed.
      version: [action, label?.name ?? assignee?.login, issue.updated_at].join(
        ":",
      ),
    })
    return
  }

  if (input.eventName === "installation") {
    const parsed = installationPayloadSchema.safeParse(input.payload)
    if (!parsed.success || parsed.data.action !== "new_permissions_accepted") {
      return
    }
    // Content the old permissions could not read (e.g. issues before
    // Issues: Read) is only mirrored by a full sync.
    const acceptedAt =
      parsed.data.installation.updated_at ?? new Date().toISOString()
    await enqueueMirror(
      {
        installationId: parsed.data.installation.id,
        githubConnectionId: input.githubConnectionId,
      },
      (connection) =>
        runWorkflowWithWorkerWake(githubSyncContent.spec, connection, {
          idempotencyKey: `github-pr-mirror-permissions:${connection.connectionId}:${acceptedAt}`,
        }),
    )
  }
}
