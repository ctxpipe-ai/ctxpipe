import { z } from "zod"

import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import { githubSyncIssue } from "../../../openworkflow/workflows/github-sync-issue.js"
import { enqueueForLinkingWorkspaces } from "./github-pr-mirror-events.js"

const issuePayloadSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    updated_at: z.string().optional(),
    /** Present when the "issue" is a pull request. */
    pull_request: z.object({}).passthrough().optional(),
  }),
  comment: z
    .object({
      updated_at: z.string().optional(),
      created_at: z.string().optional(),
    })
    .optional(),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
})

type GithubIssueMirrorRequest = {
  installationId: number
  repositoryFullName: string
  number: number
  /** The action and the time of the change; a replayed delivery has the same one. */
  version: string
}

/**
 * The issue that an `issues` or `issue_comment` delivery changed, or null.
 * Comments on pull requests go to the pull request mirror.
 */
export function githubIssueMirrorRequest(
  eventName: string,
  payload: unknown,
): GithubIssueMirrorRequest | null {
  if (eventName !== "issues" && eventName !== "issue_comment") return null
  const parsed = issuePayloadSchema.safeParse(payload)
  if (!parsed.success || parsed.data.issue.pull_request) return null
  const { action, issue, comment } = parsed.data
  const at =
    eventName === "issue_comment"
      ? (comment?.updated_at ?? comment?.created_at)
      : issue.updated_at
  return {
    installationId: parsed.data.installation.id,
    repositoryFullName: parsed.data.repository.full_name,
    number: issue.number,
    version: `${eventName}.${action}:${at ?? "unknown"}`,
  }
}

/** One `github-sync-issue` run per Workspace that links the repository. */
export async function maybeEnqueueGithubIssueMirror(input: {
  eventName: string
  payload: unknown
  githubConnectionId?: string
}): Promise<void> {
  const request = githubIssueMirrorRequest(input.eventName, input.payload)
  if (!request) return
  await enqueueForLinkingWorkspaces(
    { ...request, githubConnectionId: input.githubConnectionId },
    (target) =>
      runWorkflowWithWorkerWake(
        githubSyncIssue.spec,
        { ...target, number: request.number },
        {
          idempotencyKey: `github-issue:${target.workspaceId}:${target.gitUrl}:${request.number}:${request.version}`,
        },
      ),
  )
}
