import { z } from "zod"

/** Every "repository is gone" response uses this body. */
export const repositoryNotFoundBody = {
  error: "Repository not found or access denied",
  code: "repository_not_found",
} as const

export const repositoryNotFoundResponse = {
  description: "Repository not found or access denied",
  content: {
    "application/json": {
      schema: z.object({
        error: z.string(),
        code: z.literal("repository_not_found"),
      }),
    },
  },
}

/** A missing path or file inside a live repository has no `code`. */
export const repositoryOrPathNotFoundResponse = {
  description: "Repository, path, or file not found",
  content: {
    "application/json": {
      schema: z.object({
        error: z.string(),
        code: z.literal("repository_not_found").optional(),
      }),
    },
  },
}

/** Zoekt rejected the query syntax. The `error` string may echo the query. */
export const queryRejectedCode = "query_rejected" as const

export const queryRejectedSchema = z.object({
  error: z.string(),
  code: z.literal(queryRejectedCode),
})
