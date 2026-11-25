import { findRepositoriesByNormalizedGitUrls } from "../../models/repositories.js"
import { log } from "../../observability/logger.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import { ensureOrgRepositoryForGitUrl } from "../workspaces/ensure-org-repository.js"
import { plainGitPin } from "./plain-git-pin.js"
import { gitSourceScopeCommit, gitSourceScopeUrl } from "./providers/git.js"

/**
 * Start the first org ingestion of a linked repository that no org
 * ingestion published yet. Code search reads the published org checkout of
 * a linked repository (ADR-051). A link is often the first reference to a
 * repository, and no webhook ingests it until its next push (CTX-878). An
 * ingestion that runs already absorbs this request. A failed enqueue is
 * logged, and the next projection tries again.
 */
export async function startFirstOrgIngestion(input: {
  orgId: string
  repository: { id: string; ingested: boolean }
  step: string
}): Promise<void> {
  if (input.repository.ingested) return
  await enqueueRepositoryIngestionWorkflow(
    { repositoryId: input.repository.id, orgId: input.orgId },
    { error: () => {} },
  ).catch((error: unknown) => {
    log.error({
      step: input.step,
      repositoryId: input.repository.id,
      message: error instanceof Error ? error.message : String(error),
    })
  })
}

/**
 * Link the repository of a plain git source (CTX-815, CTX-889): make its org
 * repository row, and start its first org ingestion. A plain git source has
 * no connection, so it has no access check: ingestion reads the repository
 * with no credential under the plain git URL policy. Call it inside the org
 * context (`withOrgIdContext`), as hydrate does.
 *
 * A pin (CTX-1661) also starts an ingestion when the repository is not at
 * the commit that it must read: the pin is new or changed, or the pin no
 * longer applies (`previousScope` had a commit, or the sources of the org
 * do not agree), so the repository goes back to its branch. An ingestion of
 * a commit that the org already published does nothing.
 */
export async function linkPlainGitSource(input: {
  orgId: string
  scope: unknown
  /** The scope of the same source file at the previous projection. */
  previousScope?: unknown
}): Promise<void> {
  const url = gitSourceScopeUrl(input.scope)
  if (!url) return
  const repository = await ensureOrgRepositoryForGitUrl({
    orgId: input.orgId,
    gitUrl: url,
  })
  if (!repository) return
  const [row] = await findRepositoriesByNormalizedGitUrls([url])
  const pin = await plainGitPin({
    orgId: input.orgId,
    gitUrl: url,
    githubConnectionId: row?.githubConnectionId ?? null,
  })
  const unpinned =
    !pin &&
    (gitSourceScopeCommit(input.scope) !== null ||
      gitSourceScopeCommit(input.previousScope) !== null)
  await startFirstOrgIngestion({
    orgId: input.orgId,
    repository: {
      id: repository.id,
      ingested: pin
        ? row?.lastIngestedHash === pin
        : repository.ingested && !unpinned,
    },
    step: "workspace_sources.git.enqueue_first_ingestion",
  })
}
