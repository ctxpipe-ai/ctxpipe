import { withOrgDbContext } from "../../../db/client.js"
import { normalizeWorkspaceRepositoryUrl } from "../../../domain/workspaces/slug.js"
import {
  listOrgLinkedRepositories,
  listOrgWorkspaces,
} from "../../../models/workspaces.js"
import { getLogger } from "../../../observability/logger.js"
import { enqueueWorkspaceTipCheck } from "../../../openworkflow/enqueue-workspace-tip-check.js"

const MINUTE_MS = 60_000

/** `owner/name` of a repository URL, in lower case, on any host. */
export function repositoryPath(url: string): string | null {
  const normalized = normalizeWorkspaceRepositoryUrl(url)
  return URL.canParse(normalized)
    ? new URL(normalized).pathname.replace(/^\/+/, "").toLowerCase()
    : null
}

/**
 * Whether a push to `branch` of `repository` can move a tip that the tip
 * check of the org reads: the default branch of a Workspace repository, or
 * the ref of a linked repository (its default branch when it has no ref).
 */
async function orgReadsBranch(input: {
  orgId: string
  repository: string
  branch: string
  defaultBranch: string
}): Promise<boolean> {
  const repository = input.repository.toLowerCase()
  const [owned, linked] = await withOrgDbContext(input.orgId, () =>
    Promise.all([
      listOrgWorkspaces(input.orgId),
      listOrgLinkedRepositories(input.orgId),
    ]),
  )
  return (
    (input.branch === input.defaultBranch &&
      owned.some(
        (workspace) =>
          repositoryPath(workspace.workspaceRepositoryUrl) === repository,
      )) ||
    linked.some(
      (link) =>
        repositoryPath(link.gitUrl) === repository &&
        (link.desiredRef ?? input.defaultBranch) === input.branch,
    )
  )
}

/**
 * Queue the tip checks of a push (CTX-1305). One installation can serve
 * many orgs, and most pushes go to branches that no tip check reads: only
 * an org that reads the pushed branch gets a check. The checks of one org
 * in one minute share one run at the end of the minute. That run reads the
 * tips after each push of the minute, so a burst of pushes starts one check.
 */
export async function enqueuePushTipChecks(input: {
  orgIds: readonly string[]
  repository: string
  ref: string
  defaultBranch: string
}): Promise<void> {
  if (!input.ref.startsWith("refs/heads/")) return
  const branch = input.ref.slice("refs/heads/".length)
  const minute = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS
  const logger = getLogger()
  for (const orgId of new Set(input.orgIds)) {
    // A failed read skips this org only: the hourly check reads its tips,
    // and the other orgs and the ingestion of the push go on.
    const reads = await orgReadsBranch({
      orgId,
      repository: input.repository,
      branch,
      defaultBranch: input.defaultBranch,
    }).catch((error: unknown) => {
      logger.error(error instanceof Error ? error : new Error(String(error)), {
        step: "github_push.tip_check_filter",
        orgId,
      })
      return false
    })
    if (!reads) continue
    await enqueueWorkspaceTipCheck(orgId, logger, {
      idempotencyKey: `workspace-tip-check-push:${orgId}:${minute}`,
      availableAt: new Date(minute),
    })
  }
}
