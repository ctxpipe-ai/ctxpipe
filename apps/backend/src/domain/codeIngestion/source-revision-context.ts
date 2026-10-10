import { AsyncLocalStorage } from "node:async_hooks"
import { repositoryRevisionCheckoutKey } from "../../../../../shared/workspace-checkout.js"

export type RepositorySourceRevision = {
  orgId: string
  repositoryId: string
  sha: string
}

const sourceRevisionContext = new AsyncLocalStorage<RepositorySourceRevision>()

/** Read authority for one extraction callback; OpenWorkflow retains the durable input. */
export function withRepositorySourceRevision<T>(
  source: RepositorySourceRevision | undefined,
  fn: () => T,
): T {
  if (!source) return fn()
  repositoryRevisionCheckoutKey(source.sha)
  return sourceRevisionContext.run(source, fn)
}

export function capturedSourceRevision(
  orgId: string,
  repositoryId: string,
): RepositorySourceRevision | undefined {
  const source = sourceRevisionContext.getStore()
  if (
    source &&
    (source.orgId !== orgId || source.repositoryId !== repositoryId)
  )
    throw new Error(
      "Extraction tool repository differs from its captured source",
    )
  return source
}
