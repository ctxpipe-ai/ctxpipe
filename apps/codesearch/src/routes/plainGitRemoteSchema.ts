import { z } from "@hono/zod-openapi"

/**
 * The plain git remote that the backend checked (CTX-815), in an index or
 * ref request for a repository with no GitHub token: the checked URL, and
 * whether the deployment mode allows `http://`. Codesearch reads such a
 * repository only through it, and checks the URL again
 * (`plainGitRemoteFault`).
 */
export const plainGitRemoteSchema = z
  .object({
    url: z.string().min(1).max(2048),
    http: z.boolean(),
  })
  .openapi("PlainGitRemote")
