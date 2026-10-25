import { z } from "zod"

import { parseEnv } from "../../../config/env.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../../domain/workspaces/write-status.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { listGithubMirrorLinks } from "../../../models/github-pr-mirror.js"
import { runWorkflowWithWorkerWake } from "../../../openworkflow/client.js"
import {
  enqueueGithubIssueBackfills,
  githubSyncIssue,
} from "../../../openworkflow/workflows/github-sync-issue.js"
import { enqueueForLinkingWorkspaces } from "./github-mirror-events.js"

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

const permissionsAcceptedSchema = z.object({
  action: z.literal("new_permissions_accepted"),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string() }).nullable(),
    permissions: z.record(z.string(), z.string()),
  }),
})

/**
 * The owner of an installation accepted new App permissions. When the
 * installation can now read issues, start one more issue backfill for each
 * GitHub link of its account: the backfill that hydrate started before the
 * owner accepted was skipped. The delivery id is in the key, so a redelivery
 * starts nothing more, and an earlier backfill of the link does not block it.
 */
export async function maybeEnqueueGithubIssueBackfillsOnPermissionsAccepted(input: {
  payload: unknown
  githubConnectionId?: string
  deliveryId?: string
}): Promise<void> {
  const parsed = permissionsAcceptedSchema.safeParse(input.payload)
  if (!parsed.success || !parsed.data.installation.permissions.issues) return
  const { installation } = parsed.data
  const owner = installation.account?.login.toLowerCase()
  const connections = await listInstallationsByGithubInstallationId(
    installation.id,
    input.githubConnectionId,
    parseEnv(process.env as Record<string, string | undefined>),
  )
  for (const connection of connections) {
    const gitUrlsByWorkspace = new Map<string, string[]>()
    for (const link of await listGithubMirrorLinks(connection.orgId)) {
      const repository = githubRepoFullNameFromWorkspaceUrl(link.gitUrl)
      if (!repository) continue
      if (owner && repository.split("/")[0]?.toLowerCase() !== owner) continue
      gitUrlsByWorkspace.set(link.workspaceId, [
        ...(gitUrlsByWorkspace.get(link.workspaceId) ?? []),
        link.gitUrl,
      ])
    }
    for (const [workspaceId, gitUrls] of gitUrlsByWorkspace)
      await enqueueGithubIssueBackfills({
        orgId: connection.orgId,
        workspaceId,
        gitUrls,
        connectionId: connection.id,
        deliveryId: input.deliveryId,
      })
  }
}
