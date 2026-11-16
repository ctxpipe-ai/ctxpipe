import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"
import { listLostAccessRepositories } from "../models/repositories.js"
import { enqueueWorkflow } from "./client.js"
import { repositoryIndex } from "./workflows/repository-index.js"

/**
 * Queues a codesearch-only index of the published revision of a repository:
 * no knowledge ingestion and no model cost. `idempotencyKey` names the cause
 * of the run, so the same cause queues no second run.
 */
export async function enqueueCodesearchRebuild(
  rebuild: { orgId: string; repositoryId: string; sha: string },
  idempotencyKey: string,
): Promise<void> {
  await enqueueWorkflow(
    repositoryIndex.spec,
    {
      orgId: rebuild.orgId,
      repositoryId: rebuild.repositoryId,
      targetHash: rebuild.sha,
      ingestionV2: true,
      rebuild: true,
    },
    { idempotencyKey },
  )
}

/**
 * Queues a codesearch rebuild of each published repository of an org that
 * lost access, when the access can be back: all of them, those of one GitHub
 * connection, or only `repoFullNames` (`owner/name`). A run that gets a
 * credential ends the lost-access state (CTX-1297). `cause` keys the runs.
 */
export async function startLostAccessRebuilds(input: {
  orgId: string
  githubConnectionId?: string
  repoFullNames?: string[]
  cause: string
}): Promise<void> {
  const wanted = input.repoFullNames?.map((name) => name.toLowerCase())
  for (const repository of await listLostAccessRepositories(input)) {
    const fullName = githubRepoFullNameFromWorkspaceUrl(repository.gitUrl)
    if (wanted && !(fullName && wanted.includes(fullName.toLowerCase())))
      continue
    await enqueueCodesearchRebuild(
      { orgId: input.orgId, repositoryId: repository.id, sha: repository.sha },
      `repository-index-access:${repository.id}:${repository.sha}:${input.cause}`,
    )
  }
}
