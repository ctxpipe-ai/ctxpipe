/** Every "repository is gone" response uses this body. */
export const repositoryNotFoundBody = {
  error: "Repository not found or access denied",
  code: "repository_not_found",
} as const

/** Zoekt rejected the query syntax. The `error` string may echo the query. */
export const queryRejectedCode = "query_rejected" as const
