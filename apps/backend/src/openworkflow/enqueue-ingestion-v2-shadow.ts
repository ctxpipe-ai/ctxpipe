import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import type { IngestionV2Input } from "../domain/ingestion/ingestion-run.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { repositoryIngestionV2 } from "./workflows/repository-ingestion-v2.js"

export type IngestionV2ShadowStart =
  | { started: true; runId: string }
  | {
      started: false
      reason: "not_github" | "repository_gone"
    }

/**
 * The shadow trigger (T09): after the old pipeline ingested `sha` of a
 * repository, queue one ingestion v2 run in shadow mode at the same SHA. The
 * caller checks `ingestionV2ShadowEnabled` first. The trigger run's id is the
 * idempotency key, so a replayed trigger step queues nothing new.
 */
export async function startIngestionV2Shadow(input: {
  orgId: string
  repositoryId: string
  sha: string
  triggerRunId: string
}): Promise<IngestionV2ShadowStart> {
  const [repository] = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({
        gitUrl: repositories.gitUrl,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(eq(repositories.id, input.repositoryId))
      .limit(1),
  )
  if (!repository) return { started: false, reason: "repository_gone" }
  const url = normalizeWorkspaceRepositoryUrl(repository.gitUrl)
  if (
    !repository.githubConnectionId ||
    !githubRepoFullNameFromWorkspaceUrl(url)
  )
    return { started: false, reason: "not_github" }
  const handle = await runWorkflowWithWorkerWake(
    repositoryIngestionV2.spec,
    {
      orgId: input.orgId,
      shadow: true,
      source: { url, githubConnectionId: repository.githubConnectionId },
      sha: input.sha,
      authorTime: new Date().toISOString(),
    } satisfies IngestionV2Input,
    { idempotencyKey: `ingestion-v2-shadow:${input.triggerRunId}` },
  )
  return { started: true, runId: handle.workflowRun.id }
}
