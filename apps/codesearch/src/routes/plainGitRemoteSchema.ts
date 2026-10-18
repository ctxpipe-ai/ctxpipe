import { z } from "@hono/zod-openapi"

/**
 * The plain git remote that the backend checked (CTX-815), in an index or
 * ref request for a repository with no GitHub token: the checked URL, its
 * host and port, the addresses that the check saw, and the policy of the
 * deployment mode. Codesearch reads such a repository only through it, and
 * checks it again (`pinnedPlainGitRemoteFault`).
 */
export const plainGitRemoteSchema = z
  .object({
    url: z.string().min(1).max(2048),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    addresses: z.array(z.string().min(1).max(64)).min(1).max(32),
    policy: z.object({ http: z.boolean(), privateHosts: z.boolean() }),
  })
  .openapi("PlainGitRemote")
