import { withOrgDbContext } from "../../../db/client.js"
import { getOrgFeature } from "../../../models/org-features.js"
import { listOrgWorkspaces } from "../../../models/workspaces.js"
import { getLogger } from "../../../observability/logger.js"
import { enqueueWorkflow } from "../../../openworkflow/client.js"
import { knowledgeProjection } from "../../../openworkflow/workflows/knowledge-projection.js"
import { repositoryPath } from "./github-push-tip-check.js"

/**
 * Queue the knowledge projection of a pushed branch that is not the default
 * branch of a Workspace (ADR-071 decision 7), for each org of the push whose
 * `knowledge_plane` flag is not `off`. The hydrate queues the run of the
 * default branch. A push that deletes the branch queues the same run, which
 * finds no tip and removes the head. The key holds the pushed SHA, so a
 * redelivery of the push queues no second run; the run reads the newest
 * tip of the branch anyway.
 */
export async function enqueueKnowledgeBranchRuns(input: {
  orgIds: readonly string[]
  repository: string
  ref: string
  /** The SHA after the push; zeros when the push deleted the branch. */
  after?: string
}): Promise<void> {
  if (!input.ref.startsWith("refs/heads/")) return
  const branch = input.ref.slice("refs/heads/".length)
  const repository = input.repository.toLowerCase()
  const logger = getLogger()
  for (const orgId of new Set(input.orgIds)) {
    // A failed read skips this org only: the next push of the branch queues
    // its run, and the other orgs and the rest of the push go on.
    try {
      if ((await getOrgFeature(orgId, "knowledge_plane")) === "off") continue
      const workspaces = await withOrgDbContext(orgId, () =>
        listOrgWorkspaces(orgId),
      )
      for (const workspace of workspaces)
        if (
          repositoryPath(workspace.workspaceRepositoryUrl) === repository &&
          workspace.desiredDefaultBranch &&
          workspace.desiredDefaultBranch !== branch
        )
          await enqueueWorkflow(
            knowledgeProjection.spec,
            { orgId, workspaceId: workspace.id, branch },
            {
              idempotencyKey: `knowledge-projection:${workspace.id}:${branch}:${input.after ?? ""}`,
            },
          )
    } catch (error) {
      logger.error(error instanceof Error ? error : new Error(String(error)), {
        step: "github_push.knowledge_branch",
        orgId,
      })
    }
  }
}
