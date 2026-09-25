/**
 * Codesearch answered that the repository row is gone (deleted or no longer
 * visible to this org). Ingestion must stop instead of retrying the call.
 */
export class RepositoryGoneError extends Error {
  readonly repositoryGone = true as const

  constructor(message = "Repository not found or access denied") {
    super(message)
    this.name = "RepositoryGoneError"
  }
}

export function isRepositoryGoneError(
  err: unknown,
): err is RepositoryGoneError {
  if (err instanceof RepositoryGoneError) return true
  return err instanceof Error && err.name === "RepositoryGoneError"
}
