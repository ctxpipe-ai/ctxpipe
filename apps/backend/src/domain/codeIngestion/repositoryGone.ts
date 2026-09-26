/**
 * Codesearch answered that the repository row is gone (deleted or no longer
 * visible to this org). Ingestion must stop instead of retrying the call.
 */
export class RepositoryGoneError extends Error {
  constructor(message = "Repository not found or access denied") {
    super(message)
    this.name = "RepositoryGoneError"
  }
}

export function isRepositoryGoneError(
  err: unknown,
): err is RepositoryGoneError {
  return err instanceof RepositoryGoneError
}
